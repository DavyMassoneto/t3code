import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PiConnectionCredentialsInput,
  PiConnectionsError,
  ProviderDriverKind,
  ProviderInstanceId,
  type PiConnectionsResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PiConnectionCredentials from "./PiConnectionCredentials.ts";
import * as PiConnections from "./PiConnections.ts";
import * as Registry from "./ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";

const instanceId = ProviderInstanceId.make("pi-selected");
const otherId = ProviderInstanceId.make("pi-other");
const input = {
  instanceId,
  service: "anthropic",
  apiKey: Redacted.make("synthetic-secret-only"),
  consent: true,
} as const;
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-credential-service-" });
  const binary = path.join(root, "pi-fixture");
  const sdkFile = path.join(root, "dist", "core", "auth-storage.js");
  yield* fs.makeDirectory(path.dirname(sdkFile), { recursive: true });
  yield* fs.writeFileString(sdkFile, "synthetic SDK marker; never executed");
  yield* fs.writeFileString(binary, "synthetic binary; never executed");
  yield* fs.writeFileString(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: "pi-fixture" }),
  );
  const homes = [path.join(root, "first"), path.join(root, "second")];
  const controls = {
    enabled: true,
    driver: "pi",
    supportsKey: true,
    discovered: true,
    discoveryError: false,
    discoveryHook: Effect.void as Effect.Effect<void>,
    code: 0,
    stdout: "T3_PI_CREDENTIALS_OK\n",
    hang: false,
    cleanups: 0,
  };
  const started = yield* Deferred.make<void>();
  const launches: ChildProcess.StandardCommand[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const discoveryInputs: unknown[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          controls.cleanups += 1;
        }),
      );
      yield* Deferred.succeed(started, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_008),
        exitCode: controls.hang
          ? Effect.never
          : Effect.succeed(ChildProcessSpawner.ExitCode(controls.code)),
        isRunning: Effect.succeed(controls.hang),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            payloads.push(JSON.parse(new TextDecoder().decode(chunk)));
          }),
        ),
        stdout: Stream.make(new TextEncoder().encode(controls.stdout)),
        stderr: Stream.make(new TextEncoder().encode("synthetic-secret-only diagnostic")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const settingsService = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.provide(
      ServerSettings.layerTest({
        providerInstances: Object.fromEntries(
          [instanceId, otherId].map((id, index) => [
            id,
            {
              driver: "pi",
              enabled: true,
              config: { binaryPath: binary },
              environment: [
                { name: "pi_coding_agent_dir", value: homes[index]!, sensitive: false },
                {
                  name: "Path",
                  value: process.env.PATH ?? process.env.Path ?? "",
                  sensitive: false,
                },
              ],
            },
          ]),
        ),
      }),
    ),
  );
  const service = yield* PiConnectionCredentials.PiConnectionCredentials.pipe(
    Effect.provide(
      PiConnectionCredentials.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(root, root),
            Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
            Layer.mock(Registry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed({
                  instanceId: id,
                  driverKind: ProviderDriverKind.make(controls.driver),
                  enabled: controls.enabled,
                } as ProviderInstance),
            }),
            Layer.mock(PiConnections.PiConnections)({
              list: (request) =>
                Effect.gen(function* () {
                  discoveryInputs.push(request);
                  yield* controls.discoveryHook;
                  return yield* controls.discoveryError
                    ? Effect.fail(new PiConnectionsError({ message: "synthetic-secret-only" }))
                    : Effect.succeed<PiConnectionsResult>({
                        instanceId: request.instanceId,
                        connections: controls.discovered
                          ? [
                              {
                                service: "anthropic",
                                name: "Anthropic",
                                configured: false,
                                authMethods: controls.supportsKey ? ["api_key"] : ["oauth"],
                                authentication: "managed-in-pi",
                                limits: "unavailable",
                                models: [],
                              },
                            ]
                          : [],
                      });
                }),
            }),
            Layer.succeed(HostProcessPlatform, "win32"),
            Layer.succeed(SpawnExecutableResolution, () => binary),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      ),
    ),
  );
  return {
    service,
    controls,
    launches,
    payloads,
    homes,
    discoveryInputs,
    started,
    fs,
    sdkFile,
    settingsService,
    root,
  };
});

it.effect(
  "writes only selected native service and instance through stdin without exporting keys",
  () =>
    Effect.gen(function* () {
      const { service, launches, payloads, homes, discoveryInputs } = yield* fixture();
      expect(yield* service.setApiKey(input)).toEqual({
        instanceId,
        service: "anthropic",
        configured: true,
      });
      expect(yield* service.setApiKey({ ...input, instanceId: otherId })).toEqual({
        instanceId: otherId,
        service: "anthropic",
        configured: true,
      });
      expect(payloads.map((payload) => payload.agentDir)).toEqual(homes);
      expect(payloads.map((payload) => payload.service)).toEqual(["anthropic", "anthropic"]);
      expect(
        payloads.every(
          (payload) => payload.apiKey === "synthetic-secret-only" && payload.consent === true,
        ),
      ).toBe(true);
      expect(discoveryInputs).toEqual([{ instanceId }, { instanceId: otherId }]);
      for (const launch of launches) {
        expect(JSON.stringify(launch.args)).not.toContain("synthetic-secret-only");
        expect(JSON.stringify(launch.options.env)).not.toContain("synthetic-secret-only");
        expect(
          Object.keys(launch.options.env ?? {}).filter((name) => name.toUpperCase() === "PATH"),
        ).toEqual(["Path"]);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "rejects disabled, wrong-driver, undiscovered, OAuth-only and invalid inputs before spawning",
  () =>
    Effect.gen(function* () {
      const { service, controls, launches } = yield* fixture();
      for (const patch of [
        { enabled: false },
        { driver: "codex" },
        { discovered: false },
        { supportsKey: false },
        { discoveryError: true },
      ]) {
        Object.assign(controls, patch);
        expect((yield* service.setApiKey(input).pipe(Effect.flip)).message).not.toContain(
          "synthetic-secret-only",
        );
        Object.assign(controls, {
          enabled: true,
          driver: "pi",
          discovered: true,
          supportsKey: true,
          discoveryError: false,
        });
      }
      for (const patch of [
        { consent: false },
        { apiKey: Redacted.make("!synthetic-secret-only") },
        { apiKey: Redacted.make("synthetic-secret-only\n") },
        { service: "__proto__" },
        { service: "unregistered" },
      ]) {
        yield* service
          .setApiKey({ ...input, ...patch } as PiConnectionCredentialsInput)
          .pipe(Effect.flip);
      }
      expect(launches).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("sanitizes native failures and refuses unsupported SDKs", () =>
  Effect.gen(function* () {
    const { service, controls, fs, sdkFile } = yield* fixture();
    controls.code = 1;
    expect((yield* service.setApiKey(input).pipe(Effect.flip)).message).not.toContain(
      "synthetic-secret-only",
    );
    controls.code = 0;
    controls.stdout = "synthetic-secret-only".repeat(10);
    expect((yield* service.setApiKey(input).pipe(Effect.flip)).message).not.toContain(
      "synthetic-secret-only",
    );
    yield* fs.remove(sdkFile);
    yield* service.setApiKey(input).pipe(Effect.flip);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("refuses malformed or unrelated SDK candidates before passing any secret", () =>
  Effect.gen(function* () {
    const { service, fs, root, launches, payloads } = yield* fixture();
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(root, "unrelated-cli"), "synthetic unrelated executable");
    for (const manifest of [
      "invalid-json",
      JSON.stringify({ name: "unrelated-package", bin: "pi-fixture" }),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: "unrelated-cli" }),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: "../pi-fixture" }),
    ]) {
      yield* fs.writeFileString(path.join(root, "package.json"), manifest);
      yield* service.setApiKey(input).pipe(Effect.flip);
    }
    yield* fs.remove(path.join(root, "package.json"));
    yield* service.setApiKey(input).pipe(Effect.flip);
    expect(launches).toEqual([]);
    expect(payloads).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("refuses changed binary or environment settings during capability discovery", () =>
  Effect.gen(function* () {
    for (const change of ["binary", "environment"]) {
      const { service, controls, settingsService, launches, payloads, root } = yield* fixture();
      const current = yield* settingsService.getSettings;
      const selected = current.providerInstances[instanceId]!;
      controls.discoveryHook = settingsService
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            ...selected,
            ...(change === "binary"
              ? { config: { binaryPath: "different-synthetic-binary" } }
              : { environment: [{ name: "PI_CODING_AGENT_DIR", value: root, sensitive: false }] }),
          },
        })
        .pipe(Effect.asVoid, Effect.orDie);
      yield* service.setApiKey(input).pipe(Effect.flip);
      expect(launches).toEqual([]);
      expect(payloads).toEqual([]);
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("times out and releases the native process scope", () =>
  Effect.gen(function* () {
    const { service, controls, started, settingsService } = yield* fixture();
    controls.hang = true;
    const initial = yield* settingsService.getSettings;
    const settingsWritten = yield* Deferred.make<void>();
    const fiber = yield* service.setApiKey(input).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    const settingsFiber = yield* settingsService
      .updateSettings({
        enableAgentBrowserAccess: !initial.enableAgentBrowserAccess,
      })
      .pipe(
        Effect.tap(() => Deferred.succeed(settingsWritten, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
    yield* Effect.yieldNow;
    expect(Option.isNone(yield* Deferred.poll(settingsWritten))).toBe(true);
    yield* TestClock.adjust("31 seconds");
    expect((yield* Fiber.join(fiber)).message).not.toContain("synthetic-secret-only");
    expect(controls.cleanups).toBe(1);
    yield* Fiber.join(settingsFiber);
    expect((yield* settingsService.getSettings).enableAgentBrowserAccess).toBe(
      !initial.enableAgentBrowserAccess,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
