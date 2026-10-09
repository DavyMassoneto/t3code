import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkPiProviderStatus, MINIMUM_PI_VERSION, parseDiscoveredModels } from "./PiProvider.ts";
import { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { hydrateCachedProvider } from "./providerStatusCache.ts";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";
import { applyManifestDefault } from "./ModelManifest.ts";

const encoder = new TextEncoder();
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.some((argument) => argument.replace(/["^]/gu, "") === "--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it("does not resurrect a cached sentinel or replace the native default with a manifest preference", () => {
    const models = parseDiscoveredModels(
      {
        models: [
          { provider: "anthropic", id: "opus" },
          { provider: "openai", id: "gpt" },
        ],
      },
      "high",
      { provider: "anthropic", id: "opus" },
    );
    const fallback = decodeProvider({
      instanceId: "pi",
      driver: "pi",
      enabled: true,
      installed: true,
      version: "1.1.0",
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: "2026-10-09T00:00:00.000Z",
      models,
      slashCommands: [],
      skills: [],
    });
    const cached = {
      ...fallback,
      models: [{ ...models[0]!, slug: "default", name: "Pi default" }],
    };
    assert.isFalse(
      hydrateCachedProvider({ cachedProvider: cached, fallbackProvider: fallback }).models.some(
        (model) => model.slug === "default",
      ),
    );
    assert.isFalse(
      mergeProviderSnapshot(cached, { ...fallback, status: "warning", models: [] }).models.some(
        (model) => model.slug === "default",
      ),
    );
    assert.deepEqual(
      applyManifestDefault(
        models,
        {
          version: 1,
          currentModels: {},
          providers: {
            pi: {
              defaults: { chat: "openai/gpt" },
              profiles: {},
              models: [],
            },
          },
        },
        ProviderDriverKind.make("pi"),
      ),
      models,
    );
  });
  it("marks the actual native default without a synthetic catalog row", () => {
    const models = parseDiscoveredModels(
      {
        models: [
          { provider: "anthropic", id: "claude-opus-5-5", name: "Opus" },
          { provider: "openai", id: "gpt-5" },
        ],
      },
      "high",
      { provider: "anthropic", id: "claude-opus-5-5" },
    );
    assert.deepEqual(
      models.map((model) => [model.slug, model.isDefault]),
      [
        ["anthropic/claude-opus-5-5", true],
        ["openai/gpt-5", false],
      ],
    );
    assert.isFalse(models.some((model) => model.slug === "default"));
  });
  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(SpawnExecutableResolution, () => "C:\\mock\\pi.cmd"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(SpawnExecutableResolution, () => "C:\\mock\\pi.cmd"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        [],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["win32", "linux", "darwin"] as const)(
    "probes a compatible Pi CLI on %s without requiring an installed binary",
    (platform) =>
      Effect.gen(function* () {
        const snapshot = yield* checkPiProviderStatus(settings).pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(SpawnExecutableResolution, () => "C:\\mock\\pi.cmd"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("1.1.0")),
        );
        assert.equal(snapshot.status, "ready");
        assert.equal(snapshot.version, "1.1.0");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
