import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiConnection } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  makePiRpcConnection,
  piRecordField,
  piRecordString,
} from "../src/orchestration-v2/Adapters/PiRpc.ts";
import { makePiConnectionsExtensionSource } from "../src/provider/piConnectionsExtension.ts";
import { resolveNativePiSdkRoot } from "../src/provider/nativePiSdkRoot.ts";

class PiConnectionsNativeSmokeError extends Schema.TaggedError<PiConnectionsNativeSmokeError>()(
  "PiConnectionsNativeSmokeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Pi native connections smoke failed: ${this.detail}`;
  }
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeConnections = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PiConnection)),
);
const isSmokeError = Schema.is(PiConnectionsNativeSmokeError);
const fixtureKey = "pi-connections-smoke-synthetic-key";
const fixtureProvider = "fixture-local";
const fixtureExtensionProvider = "fixture-extension";
const fixtureLimitsProvider = "t3-limits-fixture";
const fixtureOpenaiToken = `fixture.${Buffer.from(
  encodeJson({
    iss: "https://auth.openai.com",
    aud: "https://api.openai.com/v1",
    scope: "chatgpt.tokens.use.direct resource.invoke",
    "https://api.openai.com/auth": {
      per_user_salt: "synthetic",
      encrypted_auth_metadata: "synthetic",
    },
  }),
).toString("base64url")}.fixture`;
const fixtureQuotaToken = `fixture.${Buffer.from(encodeJson({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-quota-account" } })).toString("base64url")}.fixture`;
const collisionFixture = `export default function(pi) {
  let openaiRequests = 0;
  pi.registerCommand("t3-fixture-openai-state", {description: "0", handler: async () => {}});
  globalThis.fetch = async (url, options) => {
    if (url !== "https://chatgpt.com/backend-api/wham/usage" || options?.method !== "GET" || options?.redirect !== "error" || options?.headers?.authorization !== "Bearer " + ${encodeJson(fixtureQuotaToken)} || options?.headers?.["ChatGPT-Account-Id"] !== "fixture-quota-account") throw new Error("Unexpected network request is forbidden in the isolated limits fixture.");
    openaiRequests += 1;
    pi.registerCommand("t3-fixture-openai-state", {description: String(openaiRequests), handler: async () => {}});
    return new Response(JSON.stringify({rate_limit: {primary_window: {used_percent: 42, limit_window_seconds: 18000, reset_at: 1791482400}}, credits: {balance: "7.5"}}));
  };
  let collections = 0;
  pi.registerCommand("t3-fixture-limits-state", {description: "0", handler: async () => {}});
  pi.on("session_start", (_event, ctx) => {
    ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("Credential resolution is forbidden in the isolated limits fixture."); };
  });
  pi.registerProvider(${encodeJson(fixtureLimitsProvider)}, {
    name: "Synthetic native limits fixture", api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1", apiKey: ${encodeJson(fixtureKey)},
    models: [{id: "fixture", name: "Synthetic fixture", reasoning: false,
      input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 4096, maxTokens: 1024}]
  });
  pi.events.on("t3:provider-limits:collect", request => {
    collections += 1;
    pi.registerCommand("t3-fixture-limits-state", {description: String(collections), handler: async () => {}});
    if (request.version !== 1) throw new Error("Unexpected protocol version.");
    request.register(${encodeJson(fixtureLimitsProvider)}, async ({signal}) => {
      signal.throwIfAborted();
      return {metrics: [{unit: "credits", remaining: 7.5}]};
    });
  });
  pi.registerCommand("t3-native-connections", {
    description: "This colliding command is not connection metadata.", handler: async () => {}
  });
  pi.registerProvider(${encodeJson(fixtureExtensionProvider)}, {
    name: "Fixture extension service", api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1", apiKey: ${encodeJson(fixtureKey)},
    models: [{id: "fixture-extension-model", name: "Fixture extension model", reasoning: false,
      input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 4096, maxTokens: 1024}]
  });
}`;

const runFixture = (includeLimits: boolean, openaiDiagnostic = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* HostProcessWorkingDirectory;
      const environment = yield* HostProcessEnvironment;
      const now = yield* Clock.currentTimeMillis;
      const sdkRoot = yield* resolveNativePiSdkRoot({
        binaryPath: environment.PI_BINARY_PATH || "pi",
        environment,
      });
      if (!sdkRoot)
        return yield* new PiConnectionsNativeSmokeError({
          detail: "Select a verifiable native Pi SDK binary for this isolated fixture.",
        });
      const smokeRoot = path.resolve(cwd, ".t3", "pi-connections-native-smoke");
      yield* fs.makeDirectory(smokeRoot, { recursive: true });
      const workspace = yield* fs.makeTempDirectoryScoped({ directory: smokeRoot, prefix: "run-" });
      const agentDir = path.join(workspace, "agent");
      const extensionPath = path.join(workspace, "connections.mjs");
      const collisionPath = path.join(workspace, "collision.mjs");
      yield* fs.makeDirectory(agentDir);
      const authPath = path.join(agentDir, "auth.json");
      const authJson = yield* encodeUnknownJson({
        "fixture-unused-account": { type: "api_key", key: fixtureKey },
        openai: {
          type: "oauth",
          access: fixtureOpenaiToken,
          refresh: fixtureKey,
          expires: 4102444800000,
          clientId: "synthetic-client",
          scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
        },
        "openai-codex": {
          type: "oauth",
          access: fixtureQuotaToken,
          refresh: "synthetic-quota-refresh-never-used",
          expires: now + 3600000,
          accountId: "fixture-quota-account",
        },
      });
      yield* fs.writeFileString(authPath, authJson);
      yield* fs.writeFileString(
        extensionPath,
        makePiConnectionsExtensionSource(includeLimits, {
          openaiDiagnostic,
          nativeQuotaProfile: { sdkRoot, agentDir },
        }),
      );
      yield* fs.writeFileString(collisionPath, collisionFixture);
      const modelsJson = yield* encodeUnknownJson({
        providers: {
          [fixtureProvider]: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: fixtureKey,
            models: [{ id: "fixture-model", name: "Fixture model" }],
          },
        },
      });
      yield* fs.writeFileString(path.join(agentDir, "models.json"), modelsJson);
      const spawnEnvironment: NodeJS.ProcessEnv = {};
      for (const key of [
        "PATH",
        "Path",
        "PATHEXT",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "ComSpec",
        "TEMP",
        "TMP",
        "TMPDIR",
      ]) {
        if (environment[key] !== undefined) spawnEnvironment[key] = environment[key];
      }
      const connection = yield* makePiRpcConnection({
        command: environment.PI_BINARY_PATH || "pi",
        args: [
          "--mode",
          "rpc",
          "--offline",
          "--no-session",
          "--no-extensions",
          "--extension",
          collisionPath,
          "--extension",
          extensionPath,
          "--no-skills",
          "--no-mcp",
          "--no-tools",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
        ],
        cwd: workspace,
        env: {
          ...spawnEnvironment,
          HOME: workspace,
          USERPROFILE: workspace,
          APPDATA: workspace,
          LOCALAPPDATA: workspace,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
        },
      });
      yield* Stream.fromQueue(connection.events).pipe(
        Stream.runForEach((event) => {
          if (
            event.type === "extension_ui_request" &&
            ["confirm", "select", "input", "editor"].includes(String(event.method))
          ) {
            return Effect.fail(
              new PiConnectionsNativeSmokeError({
                detail: "Unexpected interactive startup in isolated fixture.",
              }),
            );
          }
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      const data = yield* connection.request({ type: "get_commands" }, 19_000);
      const commands = piRecordField(data, "commands");
      const metadata = Array.isArray(commands)
        ? commands.find((command) => {
            const sourcePath = piRecordString(piRecordField(command, "sourceInfo"), "path");
            return (
              piRecordString(command, "source") === "extension" &&
              sourcePath !== undefined &&
              path.normalize(sourcePath) === path.normalize(extensionPath)
            );
          })
        : undefined;
      const description = piRecordString(metadata, "description");
      const invocation = piRecordString(metadata, "name");
      if (!description || invocation !== "t3-native-connections:2") {
        return yield* new PiConnectionsNativeSmokeError({
          detail: "Generated extension provenance or collision suffix was lost.",
        });
      }
      if (
        description.includes(fixtureKey) ||
        description.includes(fixtureOpenaiToken) ||
        description.includes(fixtureQuotaToken) ||
        description.includes("fixture-quota-account")
      )
        return yield* new PiConnectionsNativeSmokeError({
          detail: "Synthetic key leaked into discovery metadata.",
        });
      const connections = yield* decodeConnections(description);
      for (const service of [fixtureProvider, fixtureExtensionProvider]) {
        const provider = connections.find((candidate) => candidate.service === service);
        if (
          !provider?.configured ||
          !provider.authMethods.includes("api_key") ||
          provider.authentication !== "managed-in-pi" ||
          provider.limits !==
            (includeLimits && !openaiDiagnostic ? "unsupported" : "unavailable") ||
          !provider.models.some((model) => model.slug.startsWith(`${service}/`) && model.available)
        ) {
          return yield* new PiConnectionsNativeSmokeError({
            detail: "Custom provider native auth or model metadata was incomplete.",
          });
        }
      }
      const fixture = connections.find((candidate) => candidate.service === fixtureLimitsProvider);
      const state = Array.isArray(commands)
        ? commands.find((command) => piRecordString(command, "name") === "t3-fixture-limits-state")
        : undefined;
      if (piRecordString(state, "description") !== (includeLimits && !openaiDiagnostic ? "1" : "0"))
        return yield* new PiConnectionsNativeSmokeError({
          detail:
            "Passive discovery collected limits or explicit refresh missed the native event bus.",
        });
      const openaiState = Array.isArray(commands)
        ? commands.find((command) => piRecordString(command, "name") === "t3-fixture-openai-state")
        : undefined;
      if (piRecordString(openaiState, "description") !== (includeLimits ? "1" : "0"))
        return yield* new PiConnectionsNativeSmokeError({
          detail:
            "Native OpenAI quota OAuth did not obey explicit refresh or fixed request semantics.",
        });
      if (includeLimits) {
        const openai = connections.find((candidate) => candidate.service === "openai");
        if (
          openai?.limitsDetails?.status !== "available" ||
          openai.limitsDetails.source !== "native-openai-separate-quota-oauth" ||
          openai.limitsDetails.metrics[0]?.used !== 42 ||
          openai.limitsDetails.metrics[0]?.windowSeconds !== 18000
        )
          return yield* new PiConnectionsNativeSmokeError({
            detail: "Native OpenAI OAuth resolution did not project the synthetic quota window.",
          });
      }
      if (includeLimits && !openaiDiagnostic) {
        if (
          fixture?.limits !== "available" ||
          fixture.limitsDetails?.status !== "available" ||
          fixture.limitsDetails.source !== "pi-extension" ||
          fixture.limitsDetails.metrics.length !== 1 ||
          fixture.limitsDetails.metrics[0]?.remaining !== 7.5 ||
          fixture.limitsDetails.metrics[0]?.unit !== "credits"
        )
          return yield* new PiConnectionsNativeSmokeError({
            detail:
              "Explicit native limits refresh did not report the synthetic 7.5-credit fixture.",
          });
      } else if (
        !includeLimits &&
        connections.some((candidate) => candidate.limitsDetails !== undefined)
      )
        return yield* new PiConnectionsNativeSmokeError({
          detail: "Passive discovery unexpectedly returned account limits.",
        });
      if ((yield* fs.readFileString(authPath)) !== authJson) {
        return yield* new PiConnectionsNativeSmokeError({
          detail: "Native discovery changed the synthetic credential store.",
        });
      }
      yield* Console.log(
        "PASS native Pi registry auth metadata, models.json and extension custom providers",
      );
      yield* Console.log(
        "PASS sourceInfo generated extension provenance and suffixed command collision",
      );
      yield* Console.log(
        "PASS synthetic credentials absent from metadata; no credential writes or model prompts",
      );
      yield* Console.log(
        openaiDiagnostic
          ? "PASS explicit native OpenAI diagnostic with synthetic 42-percent quota; external network forbidden"
          : includeLimits
            ? "PASS native opt-in balance 7.5 and separate native OpenAI quota OAuth; direct token never sent"
            : "PASS passive discovery never collected account limits",
      );
    }),
  ).pipe(
    Effect.timeout("20 seconds"),
    Effect.catch((error) =>
      Effect.fail(
        isSmokeError(error)
          ? error
          : new PiConnectionsNativeSmokeError({
              detail:
                "Isolated native connection fixture failed; no native diagnostic payload is exposed.",
            }),
      ),
    ),
  );

Effect.forEach(
  [
    { includeLimits: false, openaiDiagnostic: false },
    { includeLimits: true, openaiDiagnostic: false },
    { includeLimits: true, openaiDiagnostic: true },
  ],
  (options) => runFixture(options.includeLimits, options.openaiDiagnostic),
).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
