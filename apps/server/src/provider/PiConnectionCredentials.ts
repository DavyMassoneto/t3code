import {
  PiConnectionCredentialsError,
  PiConnectionCredentialsInput,
  PiSettings,
  type PiConnectionCredentialsResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as PiConnections from "./PiConnections.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { resolveNativePiAgentDirectory } from "./nativePiAgentDirectory.ts";
import { PI_CONNECTION_CREDENTIALS_NATIVE_SOURCE } from "./piConnectionCredentialsNative.ts";

const failure = () =>
  new PiConnectionCredentialsError({
    message: "Pi API key could not be saved. Check the selected instance in native Pi and retry.",
  });

const NativePiManifest = Schema.Struct({
  name: Schema.Literal("@earendil-works/pi-coding-agent"),
  bin: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
});
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export class PiConnectionCredentials extends Context.Service<
  PiConnectionCredentials,
  {
    readonly setApiKey: (
      input: PiConnectionCredentialsInput,
    ) => Effect.Effect<PiConnectionCredentialsResult, PiConnectionCredentialsError>;
  }
>()("t3/provider/PiConnectionCredentials") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const connections = yield* PiConnections.PiConnections;
  const config = yield* ServerConfig.ServerConfig;
  const executable = yield* SpawnExecutableResolution;
  const platform = yield* HostProcessPlatform;
  const setApiKey = Effect.fnUntraced(
    function* (input: PiConnectionCredentialsInput) {
      if (!Schema.is(PiConnectionCredentialsInput)(input)) return yield* failure();
      const instance = yield* registry.getInstance(input.instanceId);
      if (!instance || instance.driverKind !== "pi" || !instance.enabled) return yield* failure();
      const current = yield* settings.getSettings;
      const entry = current.providerInstances[input.instanceId];
      const snapshot = encodeJson({ entry, legacy: entry ? undefined : current.providers.pi });
      const discovered = yield* connections.list({ instanceId: input.instanceId });
      if (
        !discovered.connections.some(
          (connection) =>
            connection.service === input.service && connection.authMethods.includes("api_key"),
        )
      )
        return yield* failure();
      return yield* settings.withSettingsSnapshot(
        Effect.fnUntraced(function* (latest) {
          if (
            encodeJson({
              entry: latest.providerInstances[input.instanceId],
              legacy: latest.providerInstances[input.instanceId] ? undefined : latest.providers.pi,
            }) !== snapshot
          )
            return yield* failure();
          if (
            (entry && (entry.driver !== "pi" || entry.enabled === false)) ||
            (!entry && input.instanceId !== "pi")
          )
            return yield* failure();
          const pi = yield* Schema.decodeEffect(PiSettings)(entry?.config ?? current.providers.pi);
          const env = { ...mergeProviderInstanceEnvironment(entry?.environment) };
          if (platform === "win32") {
            for (const variable of entry?.environment ?? []) {
              for (const name of Object.keys(env)) {
                if (name.toUpperCase() === variable.name.toUpperCase()) delete env[name];
              }
              env[variable.name] = variable.value;
            }
          }
          const agentDir = yield* Effect.try(() =>
            resolveNativePiAgentDirectory({
              environment: env,
              platform,
              fallbackHome: expandHomePathWith("~", path),
              path,
            }),
          );
          const binary = executable(expandHomePathWith(pi.binaryPath || "pi", path), platform, env);
          if (!binary) return yield* failure();
          const realBinary = yield* fs.realPath(binary);
          const binaryDirectory = path.dirname(realBinary);
          let directory = path.dirname(realBinary);
          let sdkRoot: string | undefined;
          for (let depth = 0; depth < 6 && sdkRoot === undefined; depth += 1) {
            for (const candidate of [
              directory,
              path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent"),
              path.join(directory, "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
            ]) {
              const verified = yield* Effect.gen(function* () {
                const root = yield* fs.realPath(candidate);
                const manifest = yield* fs.readFileString(path.join(root, "package.json"));
                if (manifest.length > 65536) return undefined;
                const pkg = yield* Schema.decodeEffect(Schema.fromJsonString(NativePiManifest))(
                  manifest,
                );
                const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi;
                if (!bin || path.isAbsolute(bin) || bin.split(/[\\/]/u).includes(".."))
                  return undefined;
                const cli = yield* fs.realPath(path.join(root, bin));
                const authModule = yield* fs.realPath(
                  path.join(root, "dist", "core", "auth-storage.js"),
                );
                const within = (filename: string) => {
                  const relative = path.relative(root, filename);
                  return (
                    !path.isAbsolute(relative) &&
                    relative !== ".." &&
                    !relative.startsWith(`..${path.sep}`)
                  );
                };
                if (!within(cli) || !within(authModule)) return undefined;
                if (realBinary !== cli) {
                  const shimRoot = path.join(
                    binaryDirectory,
                    "node_modules",
                    "@earendil-works",
                    "pi-coding-agent",
                  );
                  if (root !== (yield* fs.realPath(shimRoot))) return undefined;
                  if (!["pi", "pi.cmd", "pi.ps1"].includes(path.basename(realBinary)))
                    return undefined;
                  const shim = yield* fs.readFileString(realBinary);
                  if (shim.length > 65536) return undefined;
                  const normalized = shim.replace(/\\/gu, "/");
                  const suffix = `/node_modules/@earendil-works/pi-coding-agent/${bin.replace(/\\/gu, "/")}`;
                  if (
                    !["%dp0%", "%~dp0", "$basedir"].some((prefix) =>
                      normalized.includes(`"${prefix}${suffix}"`),
                    )
                  )
                    return undefined;
                }
                return root;
              }).pipe(Effect.orElseSucceed(() => undefined));
              if (verified) {
                sdkRoot = verified;
                break;
              }
            }
            directory = path.dirname(directory);
          }
          if (!sdkRoot) return yield* failure();
          const launch = yield* resolveSpawnCommand(
            "node",
            ["--input-type=module", "-e", PI_CONNECTION_CREDENTIALS_NATIVE_SOURCE],
            { env },
          );
          const child = yield* spawner.spawn(
            ChildProcess.make(launch.command, launch.args, {
              cwd: config.cwd,
              env,
              shell: launch.shell,
              forceKillAfter: "2 seconds",
            }),
          );
          const payload = encodeJson({
            sdkRoot,
            agentDir,
            service: input.service,
            apiKey: Redacted.value(input.apiKey),
            consent: true,
          });
          const [, stdout, , code] = yield* Effect.all(
            [
              Stream.run(Stream.make(new TextEncoder().encode(payload)), child.stdin),
              collectUint8StreamText({ stream: child.stdout, maxBytes: 64 }),
              Stream.runDrain(child.stderr),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (
            Number(code) !== 0 ||
            stdout.truncated ||
            stdout.invalidUtf8 ||
            stdout.text !== "T3_PI_CREDENTIALS_OK\n"
          )
            return yield* failure();
          return {
            instanceId: input.instanceId,
            service: input.service,
            configured: true as const,
          };
        }),
      );
    },
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.mapError(failure),
    Effect.catchDefect(() => Effect.fail(failure())),
  );
  return PiConnectionCredentials.of({ setApiKey });
});

export const layer = Layer.effect(PiConnectionCredentials, make);
