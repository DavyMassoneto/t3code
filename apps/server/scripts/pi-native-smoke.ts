import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { makePiRpcConnection } from "../src/orchestration-v2/Adapters/PiRpc.ts";

class PiNativeSmokeError extends Schema.TaggedError<PiNativeSmokeError>()("PiNativeSmokeError", {
  command: Schema.String,
}) {
  override get message(): string {
    return `Unexpected Pi RPC response for ${this.command}`;
  }
}

const smoke = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* HostProcessWorkingDirectory;
    const environment = yield* HostProcessEnvironment;
    const platform = yield* HostProcessPlatform;
    const agentDirectory = path.resolve(cwd, ".t3", "pi-native-smoke", "agent");
    yield* fileSystem.makeDirectory(agentDirectory, { recursive: true });
    const connection = yield* makePiRpcConnection({
      command: environment.PI_BINARY_PATH || "pi",
      args: [
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
      ],
      cwd,
      env: { ...environment, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1" },
    });
    for (const command of [
      { type: "get_state" },
      { type: "get_commands", arrayField: "commands" },
      { type: "get_entries", arrayField: "entries" },
      { type: "get_messages", arrayField: "messages" },
      { type: "get_session_stats" },
      { type: "get_available_models", arrayField: "models" },
    ]) {
      const data = yield* connection.request({ type: command.type }, 15_000);
      if (
        !Predicate.isObject(data) ||
        (command.arrayField !== undefined && !Array.isArray(data[command.arrayField]))
      ) {
        return yield* new PiNativeSmokeError({ command: command.type });
      }
      yield* Console.log(`PASS ${command.type}`);
    }
    for (const preference of [
      { type: "set_auto_compaction", field: "autoCompactionEnabled", value: false },
      { type: "set_auto_compaction", field: "autoCompactionEnabled", value: true },
      { type: "set_steering_mode", field: "steeringMode", value: "all" },
      { type: "set_steering_mode", field: "steeringMode", value: "one-at-a-time" },
      { type: "set_follow_up_mode", field: "followUpMode", value: "all" },
      { type: "set_follow_up_mode", field: "followUpMode", value: "one-at-a-time" },
    ]) {
      yield* connection.request({
        type: preference.type,
        ...(typeof preference.value === "boolean"
          ? { enabled: preference.value }
          : { mode: preference.value }),
      });
      const state = yield* connection.request({ type: "get_state" });
      if (!Predicate.isObject(state) || state[preference.field] !== preference.value) {
        return yield* new PiNativeSmokeError({ command: preference.type });
      }
      yield* Console.log(`PASS ${preference.type} ${preference.value}`);
    }
    for (const enabled of [false, true]) {
      yield* connection.request({ type: "set_auto_retry", enabled });
      yield* Console.log(`PASS set_auto_retry ${enabled}`);
    }
    yield* Console.log(`Pi native RPC smoke passed on ${platform}; no model prompt was sent.`);
  }),
);

smoke.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
