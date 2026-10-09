import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  makePiRpcConnection,
  piRecordField,
  piRecordString,
} from "../src/orchestration-v2/Adapters/PiRpc.ts";
import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../src/orchestration-v2/Adapters/piT3McpInjection.ts";
import { resolveNativePiAgentDirectory } from "../src/provider/nativePiAgentDirectory.ts";
import { makePiConnectionsExtensionSource } from "../src/provider/piConnectionsExtension.ts";
import { resolveNativePiSdkRoot } from "../src/provider/nativePiSdkRoot.ts";

const DiagnosticSummary = Schema.Struct({
  status: Schema.Literals([
    "available",
    "not_applicable",
    "unsupported",
    "error",
    "disabled",
    "cancelled",
    "timeout",
  ]),
  authType: Schema.Literals(["oauth", "api_key", "unknown"]),
  httpStatus: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ),
  metricCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type DiagnosticSummary = typeof DiagnosticSummary.Type;
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(DiagnosticSummary));
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(DiagnosticSummary));
const safeFailure = (
  status: "disabled" | "cancelled" | "timeout" | "error",
): DiagnosticSummary => ({ status, authType: "unknown", metricCount: 0 });

const diagnostic = Effect.gen(function* () {
  const argumentsList = (yield* HostProcessArguments).slice(2);
  if (
    argumentsList[0] !== "--live-probe" ||
    argumentsList.length > 2 ||
    (argumentsList.length === 2 && argumentsList[1] !== "--direct-token-probe")
  )
    return safeFailure("disabled");
  const environment = yield* HostProcessEnvironment;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const cwd = environment.PI_DIAGNOSTIC_CWD ?? (yield* HostProcessWorkingDirectory);
  const binary = environment.PI_BINARY_PATH;
  if (
    !binary ||
    !path.isAbsolute(binary) ||
    !environment.PI_CODING_AGENT_DIR ||
    !path.isAbsolute(cwd)
  )
    return safeFailure("disabled");
  const agentDir = yield* Effect.try({
    try: () => resolveNativePiAgentDirectory({ environment, platform, fallbackHome: cwd, path }),
    catch: () => "invalid_configuration" as const,
  });
  const sdkRoot = yield* resolveNativePiSdkRoot({ binaryPath: binary, environment });
  if (!sdkRoot) return safeFailure("disabled");
  const args = resolvePiLaunchArgs(environment.PI_DIAGNOSTIC_LAUNCH_ARGS ?? "");
  if (!args.ok) return safeFailure("disabled");
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-openai-limits-diagnostic-" });
    const extensionPath = path.join(directory, "diagnostic.mjs");
    yield* fs.writeFileString(
      extensionPath,
      makePiConnectionsExtensionSource(true, {
        openaiDiagnostic: true,
        diagnosticOutputOnly: true,
        directTokenProbe: argumentsList[1] === "--direct-token-probe",
        nativeQuotaProfile: { sdkRoot, agentDir },
      }),
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
      command: binary,
      args: launch.args,
      cwd,
      env: launch.env,
    });
    const startup = yield* Stream.fromQueue(connection.events).pipe(
      Stream.runForEach((event) =>
        event.type === "extension_ui_request" &&
        ["select", "confirm", "input", "editor"].includes(String(event.method))
          ? Effect.fail("cancelled" as const)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    const data = yield* Effect.raceFirst(
      connection.request({ type: "get_commands" }, 18_000),
      Fiber.join(startup).pipe(Effect.andThen(Effect.fail("cancelled" as const))),
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
    if (!description) return safeFailure("error");
    return yield* decodeSummary(description);
  }).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.succeed(safeFailure("timeout")),
    }),
    Effect.scoped,
    Effect.catch((error) =>
      Effect.succeed(safeFailure(error === "cancelled" ? "cancelled" : "error")),
    ),
  );
}).pipe(Effect.catch(() => Effect.succeed(safeFailure("error"))));

diagnostic.pipe(
  Effect.flatMap((summary) =>
    Console.log(encodeSummary(summary)).pipe(
      Effect.andThen(
        summary.status === "disabled" ? Effect.fail("live_probe_required" as const) : Effect.void,
      ),
    ),
  ),
  Effect.provide(Layer.mergeAll(Logger.layer([]), NodeServices.layer)),
  NodeRuntime.runMain,
);
