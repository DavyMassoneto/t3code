// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import { PI_DESKTOP_AUTO_MODE_EXTENSION_SOURCE } from "../src/orchestration-v2/Adapters/piDesktopAutoModeExtensionSource.ts";

type RecordValue = Record<string, unknown>;
type Scenario = {
  name: string;
  tool: "read" | "write";
  review: string;
  confirm: boolean;
  executes: boolean;
};

const timeoutMs = 20_000;
const finalText = "The local smoke scenario is complete.";
const fixtureText = "Owned Auto Mode smoke read fixture.\n";
const markerText = "Owned Auto Mode smoke write marker.\n";
const scenarios: readonly Scenario[] = [
  {
    name: "approve-read",
    tool: "read",
    review: '{"decision":"approve","risk":"low","reason":"Owned fixture read."}',
    confirm: false,
    executes: true,
  },
  {
    name: "approve-write",
    tool: "write",
    review: '{"decision":"approve","risk":"low","reason":"Owned temporary marker."}',
    confirm: false,
    executes: true,
  },
  {
    name: "ask",
    tool: "write",
    review: '{"decision":"ask","risk":"medium","reason":"Request confirmation."}',
    confirm: true,
    executes: false,
  },
  {
    name: "high",
    tool: "write",
    review: '{"decision":"approve","risk":"high","reason":"High risk requires confirmation."}',
    confirm: true,
    executes: false,
  },
  {
    name: "deny",
    tool: "write",
    review: '{"decision":"deny","risk":"high","reason":"Block this action."}',
    confirm: false,
    executes: false,
  },
  {
    name: "invalid-json",
    tool: "write",
    review: "not a JSON review",
    confirm: true,
    executes: false,
  },
];

function record(value: unknown): RecordValue {
  NodeAssert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected object",
  );
  return value as RecordValue;
}

async function bounded<Value>(promise: Promise<Value>, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isolatedEnvironment(workspace: string, agentDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    HOME: workspace,
    USERPROFILE: workspace,
    APPDATA: NodePath.join(workspace, "appdata"),
    LOCALAPPDATA: NodePath.join(workspace, "localappdata"),
    XDG_CONFIG_HOME: NodePath.join(workspace, "config"),
    XDG_CACHE_HOME: NodePath.join(workspace, "cache"),
    TEMP: NodePath.join(workspace, "tmp"),
    TMP: NodePath.join(workspace, "tmp"),
    TMPDIR: NodePath.join(workspace, "tmp"),
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}

class NativeRpc {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly events: RecordValue[] = [];
  readonly closed: Promise<void>;
  stderr = "";
  private failure: Error | undefined;
  private stopping = false;
  private sequence = 0;
  private readonly listeners = new Set<() => void>();

  constructor(child: NodeChildProcess.ChildProcessWithoutNullStreams) {
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          this.events.push(record(JSON.parse(line)));
          this.wake();
        } catch (error) {
          this.fail(error);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_384);
    });
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => {
      if (!this.stopping) this.fail(error);
    });
    this.closed = new Promise((done) =>
      child.once("close", (code, signal) => {
        if (!this.stopping) this.fail(new Error(`Pi exited ${code}/${signal}: ${this.stderr}`));
        done();
      }),
    );
  }

  fail(error: unknown) {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.wake();
  }

  private wake() {
    for (const listener of this.listeners) listener();
  }

  async wait(predicate: (event: RecordValue) => boolean, from: number, label: string) {
    let listener: (() => void) | undefined;
    try {
      return await bounded(
        new Promise<RecordValue>((done, reject) => {
          listener = () => {
            if (this.failure) {
              reject(this.failure);
              return;
            }
            const event = this.events.slice(from).find(predicate);
            if (event) done(event);
          };
          this.listeners.add(listener);
          listener();
        }),
        label,
      );
    } finally {
      if (listener) this.listeners.delete(listener);
    }
  }

  send(value: RecordValue) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async request(value: RecordValue) {
    const id = `smoke-${++this.sequence}`;
    const start = this.events.length;
    this.send({ ...value, id });
    const response = await this.wait(
      (event) => event.type === "response" && event.id === id,
      start,
      String(value.type),
    );
    NodeAssert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }

  async close() {
    this.stopping = true;
    this.child.stdin.end();
    this.child.kill();
    try {
      await bounded(this.closed, "owned Pi exit");
    } catch {
      this.child.kill("SIGKILL");
      await bounded(this.closed, "owned Pi forced exit");
    }
  }
}

function sendSse(response: NodeHttp.ServerResponse, delta: RecordValue, finishReason: string) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (content: RecordValue, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta: content, finish_reason: finish }],
    })}\n\n`;
  response.write(chunk({ role: "assistant", ...delta }, null));
  response.write(chunk({}, finishReason));
  response.end("data: [DONE]\n\n");
}

async function absent(path: string) {
  await NodeAssert.rejects(
    NodeFSP.readFile(path),
    (error: unknown) => record(error).code === "ENOENT",
  );
}

export async function runAutoModeSmoke() {
  const repository = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../..",
  );
  const smokeRoot = NodePath.join(repository, ".t3", "pi-auto-mode-smoke");
  await NodeFSP.mkdir(smokeRoot, { recursive: true });
  const root = await NodeFSP.realpath(smokeRoot);
  const workspace = await NodeFSP.mkdtemp(NodePath.join(root, "run-"));
  const agentDirectory = NodePath.join(workspace, "agent");
  let rpc: NativeRpc | undefined;
  let current:
    | { scenario: Scenario; path: string; agentRequests: number; reviewRequests: number }
    | undefined;
  const requests: { scenario: string; kind: string }[] = [];
  let serverFailure: Error | undefined;
  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      NodeAssert.ok(current, "Unexpected request outside a scenario");
      NodeAssert.equal(request.method, "POST");
      NodeAssert.equal(request.url, "/v1/chat/completions");
      NodeAssert.equal(request.headers.authorization, "Bearer fixture");
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        NodeAssert.ok(raw.length < 1_048_576, "Oversized fixture request");
      }
      const body = record(JSON.parse(raw));
      NodeAssert.equal(body.model, "fixture");
      NodeAssert.equal(body.stream, true);
      NodeAssert.ok(Array.isArray(body.messages) && body.messages.length > 0);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      requests.push({ scenario: current.scenario.name, kind: hasTools ? "agent" : "review" });
      if (!hasTools) {
        NodeAssert.equal(current.agentRequests, 1, "Review must follow the tool call");
        NodeAssert.equal(++current.reviewRequests, 1, "Exactly one native reviewer request");
        const reviewPrompt = JSON.stringify(body.messages);
        NodeAssert.ok(
          reviewPrompt.includes(current.scenario.tool),
          "Reviewer did not receive the tool",
        );
        const escapedPath = JSON.stringify(current.path).slice(1, -1);
        NodeAssert.ok(
          reviewPrompt.includes(escapedPath) ||
            reviewPrompt.includes(JSON.stringify(escapedPath).slice(1, -1)),
          "Reviewer did not receive the owned path",
        );
        sendSse(response, { content: current.scenario.review }, "stop");
        return;
      }
      const tools = (body.tools as unknown[]).map((tool) => record(record(tool).function).name);
      NodeAssert.ok(
        tools.includes("read") && tools.includes("write"),
        "Native builtin tools missing",
      );
      NodeAssert.equal(tools.length, 2, "Only owned read/write tools may be enabled");
      NodeAssert.ok(++current.agentRequests <= 2, "Unexpected autonomous loop");
      if (current.agentRequests === 2) {
        NodeAssert.equal(current.reviewRequests, 1, "Final response preceded native review");
        sendSse(response, { content: finalText }, "stop");
        return;
      }
      const args =
        current.scenario.tool === "read"
          ? { path: current.path }
          : { path: current.path, content: markerText };
      sendSse(
        response,
        {
          tool_calls: [
            {
              index: 0,
              id: `call-${current.scenario.name}`,
              type: "function",
              function: { name: current.scenario.tool, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
      );
    })().catch((error: unknown) => {
      serverFailure = error instanceof Error ? error : new Error(String(error));
      rpc?.fail(serverFailure);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = timeoutMs;
  server.on("error", (error) => {
    serverFailure = error;
    rpc?.fail(error);
  });
  try {
    await NodeFSP.mkdir(agentDirectory);
    for (const directory of ["tmp", "appdata", "localappdata", "config", "cache"])
      await NodeFSP.mkdir(NodePath.join(workspace, directory));
    await NodeFSP.writeFile(NodePath.join(agentDirectory, "auth.json"), "{}\n");
    await NodeFSP.writeFile(NodePath.join(agentDirectory, "settings.json"), "{}\n");
    const extensionPath = NodePath.join(workspace, "auto-mode.mjs");
    await NodeFSP.writeFile(extensionPath, PI_DESKTOP_AUTO_MODE_EXTENSION_SOURCE);
    server.listen(0, "127.0.0.1");
    await bounded(NodeEvents.EventEmitter.once(server, "listening"), "loopback fixture listen");
    const address = server.address();
    NodeAssert.ok(address && typeof address === "object");
    await NodeFSP.writeFile(
      NodePath.join(agentDirectory, "models.json"),
      JSON.stringify({
        providers: {
          "test-provider": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture",
            models: [
              {
                id: "fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 32_768,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const environment = isolatedEnvironment(workspace, agentDirectory);
    const command = process.env.PI_BINARY_PATH || "pi";
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-mcp",
      "--no-themes",
      "--extension",
      extensionPath,
      "--tools",
      "read,write",
      "--provider",
      "test-provider",
      "--model",
      "fixture",
    ];
    const launch = await Effect.runPromise(
      resolveSpawnCommand(command, args, { env: environment }),
    );
    rpc = new NativeRpc(
      NodeChildProcess.spawn(launch.command, [...launch.args], {
        cwd: workspace,
        env: environment,
        shell: launch.shell,
        windowsHide: true,
        stdio: "pipe",
      }),
    );
    const state = record(await rpc.request({ type: "get_state" }));
    NodeAssert.equal(record(state.model).provider, "test-provider");
    NodeAssert.equal(record(state.model).id, "fixture");
    await rpc.request({ type: "set_auto_retry", enabled: false });
    await rpc.request({ type: "set_auto_compaction", enabled: false });
    const commands = record(await rpc.request({ type: "get_commands" })).commands;
    NodeAssert.ok(Array.isArray(commands));
    NodeAssert.ok(
      commands.some((entry) => record(entry).name === "pi-desktop-policy-desktop-auto"),
      "Generated Auto Mode extension was not loaded",
    );
    const native = rpc;
    const activationStart = native.events.length;
    await Promise.all([
      native.request({
        type: "prompt",
        message: "/pi-desktop-policy-desktop-auto activate smoke-activation",
      }),
      (async () => {
        const confirmation = await native.wait(
          (event) => event.type === "extension_ui_request" && event.method === "confirm",
          activationStart,
          "Auto Mode activation confirmation",
        );
        NodeAssert.equal(confirmation.title, "Enable Auto Mode?");
        NodeAssert.equal(typeof confirmation.id, "string");
        native.send({ type: "extension_ui_response", id: confirmation.id, confirmed: true });
      })(),
    ]);
    const acknowledgement = await native.wait(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.startsWith("PI_DESKTOP_POLICY_ACK:"),
      activationStart,
      "Auto Mode activation acknowledgement",
    );
    NodeAssert.deepEqual(
      JSON.parse(String(acknowledgement.message).slice("PI_DESKTOP_POLICY_ACK:".length)),
      {
        requestId: "smoke-activation",
        policyId: "desktop-auto",
        action: "activate",
        success: true,
      },
    );
    NodeAssert.equal(requests.length, 0, "Activation must not call the model");

    for (const scenario of scenarios) {
      const path = NodePath.join(workspace, `${scenario.name}.txt`);
      if (scenario.tool === "read") await NodeFSP.writeFile(path, fixtureText);
      else await absent(path);
      current = { scenario, path, agentRequests: 0, reviewRequests: 0 };
      const start = native.events.length;
      await native.request({
        type: "prompt",
        message:
          scenario.tool === "read"
            ? `Read the owned fixture at ${path}.`
            : `Write exactly ${JSON.stringify(markerText)} to the owned temporary file at ${path}.`,
      });
      let cursor = start;
      let confirmations = 0;
      while (true) {
        const event = await native.wait(
          (candidate) =>
            candidate.type === "agent_end" ||
            (candidate.type === "extension_ui_request" && candidate.method === "confirm"),
          cursor,
          `${scenario.name} completion or confirmation`,
        );
        cursor = native.events.indexOf(event) + 1;
        if (event.type === "agent_end") break;
        NodeAssert.ok(scenario.confirm, `${scenario.name}: unexpected confirmation`);
        NodeAssert.equal(++confirmations, 1, `${scenario.name}: duplicate confirmation`);
        NodeAssert.equal(event.title, "Auto Mode: approve tool?");
        NodeAssert.equal(typeof event.id, "string");
        const confirmationText = String(event.message);
        NodeAssert.ok(
          confirmationText.includes(path) ||
            confirmationText.includes(JSON.stringify(path).slice(1, -1)),
          "Confirmation must identify the owned action",
        );
        native.send({ type: "extension_ui_response", id: event.id, confirmed: false });
      }
      NodeAssert.equal(
        confirmations,
        scenario.confirm ? 1 : 0,
        `${scenario.name}: confirmation count`,
      );
      NodeAssert.equal(current.agentRequests, 2, `${scenario.name}: agent request count`);
      NodeAssert.equal(current.reviewRequests, 1, `${scenario.name}: reviewer request count`);
      const results = native.events
        .slice(start)
        .filter((event) => event.type === "tool_execution_end");
      NodeAssert.equal(results.length, 1, `${scenario.name}: native tool result count`);
      const result = results[0]!;
      NodeAssert.equal(result.toolName, scenario.tool);
      NodeAssert.equal(result.toolCallId, `call-${scenario.name}`);
      NodeAssert.equal(result.isError, !scenario.executes, `${scenario.name}: native tool outcome`);
      const content = record(result.result).content;
      NodeAssert.ok(Array.isArray(content));
      const text = content.map((part) => record(part).text ?? "").join("\n");
      if (scenario.executes && scenario.tool === "read")
        NodeAssert.ok(text.includes(fixtureText.trim()));
      else if (scenario.executes) NodeAssert.ok(text.includes("Successfully wrote"));
      else
        NodeAssert.match(
          text,
          scenario.name === "deny" ? /Auto Mode: denied/ : /Auto Mode: tool approval declined/,
        );
      if (scenario.tool === "read")
        NodeAssert.equal(await NodeFSP.readFile(path, "utf8"), fixtureText);
      else if (scenario.executes)
        NodeAssert.equal(await NodeFSP.readFile(path, "utf8"), markerText);
      else await absent(path);
      const messages = record(await native.request({ type: "get_messages" })).messages;
      NodeAssert.ok(Array.isArray(messages));
      const toolResults = messages
        .map(record)
        .filter(
          (message) =>
            message.role === "toolResult" && message.toolCallId === `call-${scenario.name}`,
        );
      NodeAssert.equal(toolResults.length, 1, `${scenario.name}: persisted native tool result`);
      NodeAssert.equal(toolResults[0]!.isError, !scenario.executes);
      const finalMessage = record(messages.at(-1));
      NodeAssert.ok(
        finalMessage.role === "assistant" &&
          Array.isArray(finalMessage.content) &&
          finalMessage.content.some((part) => record(part).text === finalText),
        `${scenario.name}: final assistant response missing`,
      );
      console.log(
        `PASS ${scenario.name}: ${scenario.executes ? "executed" : "blocked"}; confirmations=${confirmations}`,
      );
      current = undefined;
    }
    NodeAssert.equal(serverFailure, undefined);
    NodeAssert.equal(requests.length, scenarios.length * 3);
    console.log(
      `PASS ${scenarios.length} scenarios; ${requests.length} owned loopback requests; no paid calls`,
    );
  } catch (error) {
    if (rpc?.stderr) console.error(`Owned Pi stderr: ${rpc.stderr}`);
    throw error;
  } finally {
    try {
      await rpc?.close();
    } finally {
      try {
        if (server.listening) {
          const closed = new Promise<void>((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          );
          server.closeAllConnections();
          await bounded(closed, "owned fixture server close");
        }
      } finally {
        NodeAssert.ok(
          !rpc || rpc.child.exitCode !== null || rpc.child.signalCode !== null,
          "Refusing to remove workspace while owned Pi is running",
        );
        NodeAssert.equal(
          await NodeFSP.realpath(smokeRoot),
          root,
          "Smoke root changed before cleanup",
        );
        const target = await NodeFSP.realpath(workspace);
        const childPath = NodePath.relative(root, target);
        NodeAssert.ok(
          childPath.startsWith("run-") &&
            !childPath.includes(NodePath.sep) &&
            !NodePath.isAbsolute(childPath) &&
            NodePath.dirname(target) === root &&
            target === NodePath.resolve(workspace),
          "Refusing unsafe recursive removal",
        );
        await NodeFSP.rm(target, { recursive: true, force: true });
        console.log(`Cleaned owned workspace: ${target}`);
      }
    }
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  await runAutoModeSmoke();
}
