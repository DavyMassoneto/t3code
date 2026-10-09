import {
  PiConnectionsError,
  PiConnection,
  type PiConnectionsResult,
  PiSettings,
  type PiConnectionsInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import {
  makePiRpcConnection,
  piRecordField,
  piRecordString,
} from "../orchestration-v2/Adapters/PiRpc.ts";
import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../orchestration-v2/Adapters/piT3McpInjection.ts";
import { makePiConnectionsExtensionSource } from "./piConnectionsExtension.ts";
import { resolveNativePiSdkRoot } from "./nativePiSdkRoot.ts";
import { resolveNativePiAgentDirectory } from "./nativePiAgentDirectory.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expandHomePathWith } from "../pathExpansion.ts";

const decodePiSettings = Schema.decodeUnknownEffect(PiSettings);
const decodePiConnections = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PiConnection)),
);
const isPiConnectionsError = Schema.is(PiConnectionsError);

export class PiConnections extends Context.Service<
  PiConnections,
  {
    readonly list: (
      input: PiConnectionsInput,
    ) => Effect.Effect<PiConnectionsResult, PiConnectionsError>;
  }
>()("t3/provider/PiConnections") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { cwd } = yield* ServerConfig.ServerConfig;
  const list = Effect.fnUntraced(
    function* (input: PiConnectionsInput) {
      const instance = yield* registry.getInstance(input.instanceId);
      if (!instance || instance.driverKind !== "pi" || !instance.enabled) {
        return yield* new PiConnectionsError({ message: "Select an enabled Pi instance." });
      }
      const currentSettings = yield* settings.getSettings;
      const entry = currentSettings.providerInstances[input.instanceId];
      const config = yield* decodePiSettings(entry?.config ?? currentSettings.providers.pi);
      const args = resolvePiLaunchArgs(config.launchArgs);
      if (!args.ok)
        return yield* new PiConnectionsError({ message: "Pi launch arguments are invalid." });
      const temporaryDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-connections-" });
      const extensionPath = path.join(temporaryDir, "connections.mjs");
      const environment = mergeProviderInstanceEnvironment(entry?.environment);
      const sdkRoot =
        input.includeLimits === true
          ? yield* resolveNativePiSdkRoot({ binaryPath: config.binaryPath, environment }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            )
          : undefined;
      const platform = yield* HostProcessPlatform;
      const agentDir = yield* Effect.try(() =>
        resolveNativePiAgentDirectory({
          environment,
          platform,
          fallbackHome: expandHomePathWith("~", path),
          path,
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      yield* fs.writeFileString(
        extensionPath,
        makePiConnectionsExtensionSource(
          input.includeLimits === true,
          sdkRoot && agentDir ? { nativeQuotaProfile: { sdkRoot, agentDir } } : {},
        ),
      );
      const launch = buildPiRpcLaunch({
        launchArgs: [...args.args, "--offline"],
        environment,
        mcpSession: undefined,
        extensionPath,
        ephemeral: true,
        disableTools: true,
      });
      const connection = yield* makePiRpcConnection({
        command: config.binaryPath || "pi",
        args: launch.args,
        cwd,
        env: launch.env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const uiEvents = yield* Stream.fromQueue(connection.events).pipe(
        Stream.runForEach((event) => {
          if (
            event.type !== "extension_ui_request" ||
            !["select", "confirm", "input", "editor"].includes(String(event.method))
          )
            return Effect.void;
          const id = piRecordString(event, "id");
          if (!id)
            return Effect.fail(
              new PiConnectionsError({
                message: "Pi discovery cannot answer this startup dialog.",
              }),
            );
          return Effect.fail(
            new PiConnectionsError({
              message:
                "Pi connection discovery was cancelled because an extension requested an interactive startup dialog. Open this instance in native Pi to complete setup, then refresh.",
            }),
          );
        }),
        Effect.forkScoped,
      );
      const data = yield* Effect.raceFirst(
        connection.request({ type: "get_commands" }),
        Fiber.join(uiEvents).pipe(
          Effect.andThen(
            Effect.fail(new PiConnectionsError({ message: "Pi discovery event stream ended." })),
          ),
        ),
      );
      const commands = piRecordField(data, "commands");
      const command = Array.isArray(commands)
        ? commands.find((candidate) => {
            const sourcePath = piRecordString(piRecordField(candidate, "sourceInfo"), "path");
            return (
              piRecordString(candidate, "source") === "extension" &&
              sourcePath !== undefined &&
              path.normalize(sourcePath) === path.normalize(extensionPath)
            );
          })
        : undefined;
      const description = piRecordString(command, "description");
      if (!description)
        return yield* new PiConnectionsError({
          message: "Native connection discovery requires Pi 1.1 or newer.",
        });
      const connections = yield* decodePiConnections(description);
      return { instanceId: input.instanceId, connections };
    },
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.catch((error) =>
      Effect.fail(
        isPiConnectionsError(error)
          ? error
          : new PiConnectionsError({
              message:
                "Pi native connections could not be discovered. Check this instance in Pi and refresh.",
            }),
      ),
    ),
  );
  return PiConnections.of({ list });
});

export const layer = Layer.effect(PiConnections, make);
