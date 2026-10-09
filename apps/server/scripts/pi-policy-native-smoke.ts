import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PI_RUNTIME_POLICY_ACK_PREFIX,
  PI_RUNTIME_POLICY_COMMAND_PREFIX,
  PI_RUNTIME_POLICY_METADATA_PREFIX,
  type ProviderRuntimePolicy,
} from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import {
  makePiRpcConnection,
  piRecordField,
  piRecordString,
} from "../src/orchestration-v2/Adapters/PiRpc.ts";
import { parsePiRuntimePolicies } from "../src/provider/PiCommands.ts";
import { randomUuidV4 } from "../src/orchestration-v2/RandomUuid.ts";

class PiPolicyNativeSmokeError extends Schema.TaggedError<PiPolicyNativeSmokeError>()(
  "PiPolicyNativeSmokeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Pi policy native smoke failed: ${this.detail}`;
  }
}

const jsonCodec = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(jsonCodec);

const descriptor = {
  id: "example-auto",
  label: "AUTO",
  extensionName: "Example Auto",
  description: "Session-only example policy for the offline native smoke.",
} satisfies Omit<ProviderRuntimePolicy, "command">;
const commandName = `${PI_RUNTIME_POLICY_COMMAND_PREFIX}${descriptor.id}`;
const description = `${PI_RUNTIME_POLICY_METADATA_PREFIX}${encodeJson(descriptor)}`;
const barrier = "PI_POLICY_NATIVE_SMOKE_BARRIER";

const fixture = `export default function (pi) {
  let active = false;
  pi.registerCommand(${encodeJson(commandName)}, {
    description: ${encodeJson(description)},
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\\s+/);
      const [action, requestId] = tokens;
      if (tokens.length !== 2 || !/^(activate|deactivate)$/.test(action) ||
          !/^[A-Za-z0-9_-]+$/.test(requestId)) {
        throw new Error("Expected <activate|deactivate> <requestId>");
      }
      const success = action === "activate" ? !active : active;
      if (success) active = action === "activate";
      ctx.ui.notify(${encodeJson(PI_RUNTIME_POLICY_ACK_PREFIX)} + JSON.stringify({
        requestId, policyId: "example-auto", action, success,
      }));
    },
  });
  pi.registerCommand("auto", {
    description: "Ordinary auto command, not a desktop policy.",
    handler: async (_args, ctx) => ctx.ui.notify(${encodeJson(barrier)}),
  });
}`;

const smoke = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* HostProcessWorkingDirectory;
    const environment = yield* HostProcessEnvironment;
    const platform = yield* HostProcessPlatform;
    const smokeRoot = path.resolve(cwd, ".t3", "pi-policy-native-smoke");
    yield* fileSystem.makeDirectory(smokeRoot, { recursive: true });
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      directory: smokeRoot,
      prefix: "run-",
    });
    const agentDirectory = path.join(workspace, "agent");
    const extensionPath = path.join(workspace, "policy.ts");
    yield* fileSystem.makeDirectory(agentDirectory);
    yield* fileSystem.writeFileString(extensionPath, fixture);
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
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
    });
    const data = yield* connection.request({ type: "get_commands" }, 15_000);
    const commands = piRecordField(data, "commands");
    if (!Array.isArray(commands)) {
      return yield* new PiPolicyNativeSmokeError({ detail: "get_commands missing commands" });
    }
    const policyCommand = commands.find(
      (command) => piRecordString(command, "name") === commandName,
    );
    const autoCommand = commands.find((command) => piRecordString(command, "name") === "auto");
    if (
      piRecordString(policyCommand, "source") !== "extension" ||
      piRecordString(policyCommand, "description") !== description ||
      piRecordString(autoCommand, "source") !== "extension"
    ) {
      return yield* new PiPolicyNativeSmokeError({
        detail: "extension metadata/source not preserved",
      });
    }
    yield* Console.log("PASS get_commands preserves explicit extension metadata/source");
    const initialEntries = piRecordField(
      yield* connection.request({ type: "get_entries" }),
      "entries",
    );
    if (!Array.isArray(initialEntries)) {
      return yield* new PiPolicyNativeSmokeError({
        detail: "get_entries missing baseline entries",
      });
    }

    const takeNotification = (expected: string) =>
      Effect.gen(function* () {
        const event = yield* Queue.take(connection.events);
        if (event.type !== "extension_ui_request" || event.method !== "notify") {
          return yield* new PiPolicyNativeSmokeError({
            detail: `unexpected event ${String(event.type)}; policy commands must not start an agent run`,
          });
        }
        const message = piRecordString(event, "message");
        if (message?.startsWith(expected)) return message;
        return yield* new PiPolicyNativeSmokeError({
          detail: `unexpected notification ${message}`,
        });
      }).pipe(Effect.timeout("15 seconds"));

    for (const [action, success] of [
      ["activate", true],
      ["deactivate", true],
      ["deactivate", false],
      ["activate", true],
      ["deactivate", true],
    ] as const) {
      const requestId = yield* randomUuidV4;
      const result = yield* connection.request(
        {
          type: "prompt",
          message: `/${commandName} ${action} ${requestId}`,
        },
        15_000,
      );
      if (piRecordString(result, "disposition") !== "handled") {
        return yield* new PiPolicyNativeSmokeError({
          detail: `${action} was not handled by the extension: ${encodeJson(result)}`,
        });
      }
      const message = yield* takeNotification(PI_RUNTIME_POLICY_ACK_PREFIX);
      const ack = yield* Schema.decodeEffect(jsonCodec)(
        message.slice(PI_RUNTIME_POLICY_ACK_PREFIX.length),
      ).pipe(Effect.mapError(() => new PiPolicyNativeSmokeError({ detail: "invalid ACK JSON" })));
      if (
        piRecordString(ack, "requestId") !== requestId ||
        piRecordString(ack, "policyId") !== descriptor.id ||
        piRecordString(ack, "action") !== action ||
        piRecordField(ack, "success") !== success
      ) {
        return yield* new PiPolicyNativeSmokeError({ detail: `${action} ACK mismatch` });
      }
      yield* Console.log(
        `PASS ${action} handled + matching ${success ? "positive" : "negative"} ACK`,
      );
    }
    const barrierResult = yield* connection.request({ type: "prompt", message: "/auto" }, 15_000);
    if (piRecordString(barrierResult, "disposition") !== "handled") {
      return yield* new PiPolicyNativeSmokeError({ detail: "ordinary /auto was not handled" });
    }
    yield* takeNotification(barrier);
    const state = yield* connection.request({ type: "get_state" });
    const entries = piRecordField(yield* connection.request({ type: "get_entries" }), "entries");
    const messages = piRecordField(yield* connection.request({ type: "get_messages" }), "messages");
    if (
      piRecordField(state, "isStreaming") !== false ||
      !Array.isArray(entries) ||
      encodeJson(entries) !== encodeJson(initialEntries) ||
      !Array.isArray(messages) ||
      messages.length !== 0
    ) {
      return yield* new PiPolicyNativeSmokeError({
        detail: `policy command started a conversation/model turn: ${encodeJson({ state, entries, messages })}`,
      });
    }
    yield* Console.log(
      "PASS event barrier, idle state, unchanged entries and empty messages: no agent/model run",
    );

    const policies = parsePiRuntimePolicies(data);
    if (
      !Array.isArray(policies) ||
      policies.length !== 1 ||
      piRecordString(policies[0], "id") !== descriptor.id ||
      piRecordString(policies[0], "command") !== commandName ||
      piRecordString(policies[0], "label") !== descriptor.label ||
      piRecordString(policies[0], "extensionName") !== descriptor.extensionName ||
      piRecordString(policies[0], "description") !== descriptor.description
    ) {
      return yield* new PiPolicyNativeSmokeError({
        detail: "policy discovery included arbitrary /auto or lost example-auto metadata",
      });
    }
    yield* Console.log(
      "PASS parsePiRuntimePolicies excludes arbitrary /auto and preserves policy metadata",
    );
    yield* Console.log(
      `Pi policy native RPC smoke passed on ${platform}; no model prompt or credentials used.`,
    );
  }),
);

smoke.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
