import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  checkPiProviderStatus,
  discoverPiCommandsForCwd,
  MINIMUM_PI_VERSION,
  parseDiscoveredModels,
} from "./PiProvider.ts";
import * as ServerConfig from "../config.ts";
import { PI_DESKTOP_AUTO_MODE_EXTENSION_SOURCE } from "../orchestration-v2/Adapters/piDesktopAutoModeExtensionSource.ts";
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

const makeDiscoverySpawner = Effect.fnUntraced(function* (includeCommands = true) {
  const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer));
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const paths: string[] = [];
  const requests: string[] = [];
  const commands: Array<{ name: string; source: string; description: string }> = [];
  let buffer = "";
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return processHandle({ exitCode: 1 });
      if (command.args.includes("--version")) return processHandle({ stdout: "pi 1.1.0\n" });
      const extensionIndex = command.args.indexOf("--extension");
      const extensionPath = command.args[extensionIndex + 1]!;
      paths.push(extensionPath);
      const source = yield* fs.readFileString(extensionPath);
      assert.equal(source, PI_DESKTOP_AUTO_MODE_EXTENSION_SOURCE);
      assert.include(command.args, "--no-session");
      NodeVM.runInNewContext(`(${source.replace("export default ", "")})`)({
        on: () => {},
        registerCommand: (name: string, registered: { description: string }) =>
          commands.push({ name, source: "extension", description: registered.description }),
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffer += new TextDecoder().decode(chunk);
            while (buffer.includes("\n")) {
              const newline = buffer.indexOf("\n");
              const request = JSON.parse(buffer.slice(0, newline)) as { id: string; type: string };
              buffer = buffer.slice(newline + 1);
              requests.push(request.type);
              const data =
                request.type === "get_commands"
                  ? { commands: includeCommands ? commands : [] }
                  : request.type === "get_available_models"
                    ? { models: [] }
                    : {};
              yield* Queue.offer(
                stdout,
                encoder.encode(
                  `${JSON.stringify({
                    type: "response",
                    id: request.id,
                    command: request.type,
                    success: true,
                    data,
                  })}\n`,
                ),
              );
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, paths, requests, fs };
});

const discoveryTestLayer = (prefix: string) =>
  Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provide(NodeServices.layer)),
  );

describe("PiProvider", () => {
  it.effect(
    "fails project discovery before spawning when the bundled source cannot be written",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const blockedCache = `${config.providerStatusCacheDir}/blocked`;
        yield* fs.makeDirectory(config.providerStatusCacheDir, { recursive: true });
        yield* fs.writeFileString(blockedCache, "not a directory");
        const fake = yield* makeDiscoverySpawner();
        const result = yield* discoverPiCommandsForCwd(settings, {}, process.cwd()).pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            providerStatusCacheDir: blockedCache,
          }),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(result));
        assert.deepEqual(fake.paths, []);
      }).pipe(Effect.scoped, Effect.provide(discoveryTestLayer("pi-provider-discovery-failure-"))),
  );
  it.effect.each([true, false])(
    "discovers only live policies without requiring filesystem services (catalog=%s)",
    (includeCommands) =>
      Effect.gen(function* () {
        const fake = yield* makeDiscoverySpawner(includeCommands);
        const snapshot = yield* checkPiProviderStatus(settings).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(SpawnExecutableResolution, () => "pi"),
        );
        assert.deepEqual(
          snapshot.runtimePolicies?.map((policy) => [policy.id, policy.label]) ?? [],
          includeCommands ? [["desktop-auto", "Auto Mode"]] : [],
        );
        assert.equal(snapshot.supportedRuntimeModes?.includes("auto") ?? false, includeCommands);
        assert.deepEqual(fake.requests, ["get_state", "get_available_models", "get_commands"]);
        assert.equal(fake.paths.length, 1);
        assert.isFalse(yield* fake.fs.exists(fake.paths[0]!));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "uses the server cache for project discovery when optional services are available",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeDiscoverySpawner();
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const catalog = yield* discoverPiCommandsForCwd(settings, {}, process.cwd()).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(SpawnExecutableResolution, () => "pi"),
        );
        assert.deepEqual(
          catalog.runtimePolicies.map((policy) => [policy.id, policy.label]),
          [["desktop-auto", "Auto Mode"]],
        );
        assert.equal(
          fake.paths[0],
          `${config.providerStatusCacheDir.replace(/\\/g, "/")}/pi-desktop-auto-mode-extension.mjs`,
        );
        assert.equal(
          yield* fs.readFileString(fake.paths[0]!),
          PI_DESKTOP_AUTO_MODE_EXTENSION_SOURCE,
        );
        assert.deepEqual(fake.requests, ["get_commands"]);
      }).pipe(Effect.scoped, Effect.provide(discoveryTestLayer("pi-provider-discovery-"))),
  );
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
