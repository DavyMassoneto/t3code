import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";
import { PI_OPENAI_QUOTA_AUTH_NATIVE_SOURCE } from "./piOpenaiQuotaAuthNative.ts";

const NativeQuotaAuthEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("device_code"),
    url: Schema.Literal("https://auth.openai.com/codex/device"),
    userCode: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/u)),
  }),
  Schema.Struct({ type: Schema.Literal("complete"), configured: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("error") }),
]);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeQuotaAuthEvent));
const encodeInput = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const makePiOpenaiQuotaAuth = Effect.fn("makePiOpenaiQuotaAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly agentDir: string;
  readonly sdkRoot: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const failure = (operation: string) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail:
        "Native Pi OpenAI quota authorization could not be completed. Retry sign-in in the selected Pi profile.",
    });
  if (![options.agentDir, options.sdkRoot, options.cwd].every(path.isAbsolute))
    return yield* failure("start");
  const run = Effect.fnUntraced(
    function* (
      action: "login" | "logout",
      onDevice: (event: { readonly url: string; readonly userCode: string }) => Effect.Effect<void>,
    ) {
      const launch = yield* resolveSpawnCommand(
        "node",
        ["--input-type=module", "-e", PI_OPENAI_QUOTA_AUTH_NATIVE_SOURCE],
        { env: options.environment },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(launch.command, launch.args, {
          cwd: options.cwd,
          env: options.environment,
          shell: launch.shell,
          forceKillAfter: "2 seconds",
        }),
      );
      let completed = false;
      let deviceSeen = false;
      let totalBytes = 0;
      const output = child.stdout.pipe(
        Stream.mapEffect((chunk) =>
          Effect.gen(function* () {
            totalBytes += chunk.byteLength;
            if (totalBytes > 4096) return yield* failure(action);
            return chunk;
          }),
        ),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.gen(function* () {
            const event = yield* decodeEvent(line);
            if (completed || event.type === "error") return yield* failure(action);
            if (event.type === "device_code") {
              if (action !== "login" || deviceSeen) return yield* failure(action);
              deviceSeen = true;
              yield* onDevice(event);
            } else {
              if (event.configured !== (action === "login") || (action === "login" && !deviceSeen))
                return yield* failure(action);
              completed = true;
            }
          }),
        ),
      );
      const [, , , code] = yield* Effect.all(
        [
          Stream.run(
            Stream.make(
              new TextEncoder().encode(
                encodeInput({
                  sdkRoot: options.sdkRoot,
                  agentDir: options.agentDir,
                  action,
                  consent: true,
                }),
              ),
            ),
            child.stdin,
          ),
          output,
          Stream.runDrain(child.stderr),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0 || !completed) return yield* failure(action);
      yield* options.onChanged;
    },
    Effect.mapError(() => failure("authorize")),
  );
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: {
      owner: "provider",
      key: `pi-openai-quota:${path.normalize(options.agentDir)}`,
    },
    methods: Effect.succeed([
      {
        id: "pi-openai-quota-device",
        name: "OpenAI subscription quota (native Pi)",
        description:
          "Authorize a separate native Pi ChatGPT quota login. Direct OpenAI inference authentication is unchanged; sign in to the intended subscription account.",
        type: "credentials" as const,
      },
    ]),
    defaultMethodId: "pi-openai-quota-device",
    timeoutMs: 300000,
    authenticate: (_methodId, context) =>
      run("login", (event) =>
        context.setInteraction({
          type: "deviceCode",
          id: context.flowId,
          url: event.url,
          userCode: event.userCode,
        }),
      ),
    logout: run("logout", () => Effect.void).pipe(Effect.scoped),
  });
  const { withAccess: _withAccess, ...quotaController } = controller;
  return {
    ...quotaController,
    affectsInference: false,
    start: (
      ownerSessionId: string,
      _stopSessions?: Effect.Effect<void, ProviderSetupError>,
      methodId?: string,
      returnUrl?: string,
      callbackMode?: "server" | "client",
    ) => controller.start(ownerSessionId, Effect.void, methodId, returnUrl, callbackMode),
    logout: (_stopSessions: Effect.Effect<void, ProviderSetupError>) =>
      controller.logout(Effect.void),
  };
});
