import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PiSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Registry from "./ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import * as PiConnections from "./PiConnections.ts";
import { PI_CONNECTIONS_COMMAND } from "./piConnectionsExtension.ts";

const layerTest = NodeServices.layer;
const connections = [
  {
    service: "custom",
    name: "Custom",
    configured: true,
    authMethods: ["api_key"],
    authentication: "managed-in-pi",
    limits: "unavailable",
    models: [{ slug: "custom/model", name: "Model", available: true }],
  },
];

const runTest = Effect.fnUntraced(function* (
  fail: boolean,
  enabled = true,
  startupDialog = false,
  includeLimits = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-connections-test-" });
  const homes = [path.join(directory, "first"), path.join(directory, "second")];
  yield* Effect.forEach(homes, (home) => fs.makeDirectory(home, { recursive: true }));
  const launches: Array<ChildProcess.StandardCommand> = [];
  const extensionSources: Array<string> = [];
  const cancellations: Array<unknown> = [];
  const decodeRequest = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  );
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const stdout = yield* Queue.unbounded<Uint8Array>();
      let pendingRequest: Record<string, unknown> | undefined;
      const extensionPath = command.args[command.args.indexOf("--extension") + 1]!;
      extensionSources.push(yield* fs.readFileString(extensionPath));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            let request = yield* decodeRequest(new TextDecoder().decode(chunk).trim()).pipe(
              Effect.orDie,
            );
            if (startupDialog && request.type === "get_commands") {
              pendingRequest = request;
              return yield* Queue.offer(
                stdout,
                new TextEncoder().encode(
                  `${JSON.stringify({ type: "extension_ui_request", id: "startup-dialog", method: "confirm", message: "NEVER_EXPORT_DIALOG" })}\n`,
                ),
              ).pipe(Effect.asVoid);
            }
            if (request.type === "extension_ui_response") {
              cancellations.push(request);
              request = pendingRequest!;
            }
            return yield* Queue.offer(
              stdout,
              new TextEncoder().encode(
                `${JSON.stringify({
                  type: "response",
                  id: request.id,
                  success: !fail,
                  ...(fail
                    ? { error: "NEVER_EXPORT_PROVIDER_KEY" }
                    : {
                        data: {
                          commands: [
                            {
                              name: PI_CONNECTIONS_COMMAND,
                              source: "prompt",
                              description: "NEVER_EXPORT_COLLISION",
                              sourceInfo: { path: extensionPath },
                            },
                            {
                              name: PI_CONNECTIONS_COMMAND,
                              source: "extension",
                              description: "NEVER_EXPORT_COLLISION",
                              sourceInfo: { path: "other-extension.mjs" },
                            },
                            {
                              name: `${PI_CONNECTIONS_COMMAND}:2`,
                              source: "extension",
                              sourceInfo: { path: extensionPath },
                              description: JSON.stringify(
                                includeLimits
                                  ? connections.map((connection) => ({
                                      ...connection,
                                      limits: "available",
                                      limitsDetails: {
                                        status: "available",
                                        checkedAt: "2026-10-08T12:00:00.000Z",
                                        source: "pi-extension",
                                        metrics: [
                                          {
                                            id: "balance",
                                            label: "Balance",
                                            unit: "credits",
                                            remaining: 7.5,
                                          },
                                        ],
                                      },
                                    }))
                                  : connections,
                              ),
                            },
                          ],
                        },
                      }),
                })}\n`,
              ),
            ).pipe(Effect.asVoid);
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
  const firstId = ProviderInstanceId.make("pi-first");
  const secondId = ProviderInstanceId.make("pi-second");
  const config = yield* Schema.decodeUnknownEffect(PiSettings)({
    binaryPath: "pi-native-test",
    launchArgs: "--offline",
  });
  const instances = [firstId, secondId].map((instanceId) => ({
    instanceId,
    driver: ProviderDriverKind.make("pi"),
    enabled,
    config,
    environment: [
      {
        name: "PI_CODING_AGENT_DIR",
        value: instanceId === firstId ? homes[0]! : homes[1]!,
        sensitive: false,
      },
    ],
  }));
  const serviceLayer = PiConnections.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: (instanceId) =>
            Effect.succeed({
              instanceId,
              driverKind: ProviderDriverKind.make("pi"),
              enabled,
            } as ProviderInstance),
        }),
        ServerSettings.layerTest({
          providerInstances: Object.fromEntries(
            instances.map((instance) => [instance.instanceId, instance]),
          ),
        }),
        ServerConfig.layerTest(directory, directory),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
    Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
    Layer.provide(Layer.succeed(Path.Path, path)),
  );
  const results = yield* Effect.gen(function* () {
    const service = yield* PiConnections.PiConnections;
    return yield* Effect.forEach([firstId, secondId], (instanceId) =>
      service.list({ instanceId, includeLimits }).pipe(Effect.result),
    );
  }).pipe(Effect.provide(serviceLayer));
  return { results, launches, homes, fs, cancellations, extensionSources };
});

it.effect("discovers each selected instance in its isolated Pi home", () =>
  Effect.gen(function* () {
    const { results, launches, homes, fs } = yield* runTest(false);
    expect(results.every((result) => result._tag === "Success")).toBe(true);
    expect(launches).toHaveLength(2);
    expect(launches.map((launch) => launch.options.env?.PI_CODING_AGENT_DIR)).toEqual(homes);
    for (const launch of launches) {
      expect(launch.args).toContain("--no-session");
      expect(launch.args).toContain("--no-tools");
      expect(launch.args).toContain("--offline");
      const extensionPath = launch.args[launch.args.indexOf("--extension") + 1]!;
      expect(yield* fs.exists(extensionPath)).toBe(false);
    }
    for (const home of homes) expect(yield* fs.readDirectory(home)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("forwards explicit limits refresh to only the selected native child", () =>
  Effect.gen(function* () {
    const { results, launches, homes, extensionSources } = yield* runTest(false, true, false, true);
    expect(results.every((result) => result._tag === "Success")).toBe(true);
    expect(launches.map((launch) => launch.options.env?.PI_CODING_AGENT_DIR)).toEqual(homes);
    expect(extensionSources.every((source) => source.includes("const includeLimits = true;"))).toBe(
      true,
    );
    expect(extensionSources.every((source) => source.includes("getApiKeyAndHeaders"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("never exposes native failure text", () =>
  Effect.gen(function* () {
    const { results } = yield* runTest(true);
    expect(JSON.stringify(results)).not.toContain("NEVER_EXPORT");
    expect(results.every((result) => result._tag === "Failure")).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("does not launch a disabled Pi instance", () =>
  Effect.gen(function* () {
    const { results, launches } = yield* runTest(false, false);
    expect(launches).toEqual([]);
    expect(results.every((result) => result._tag === "Failure")).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("fails discovery immediately for interactive startup without granting consent", () =>
  Effect.gen(function* () {
    const { results, cancellations } = yield* runTest(false, true, true);
    expect(results.every((result) => result._tag === "Failure")).toBe(true);
    expect(cancellations).toEqual([]);
    expect(JSON.stringify(results)).toContain("interactive startup dialog");
    expect(JSON.stringify(results)).not.toContain("NEVER_EXPORT_DIALOG");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
