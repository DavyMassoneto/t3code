// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  resolveKnownWindowsCliDirs,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import { PI_DESKTOP_AUTO_MODE_EXTENSION_SOURCE } from "../src/orchestration-v2/Adapters/piDesktopAutoModeExtensionSource.ts";
import { resolveNativePiSdkRoot } from "../src/provider/nativePiSdkRoot.ts";

type RecordValue = Record<string, unknown>;
type Step = {
  tool: "read" | "write";
  path: string;
  review?: string | undefined;
  unavailable?: boolean;
  confirm?: boolean;
  executes: boolean;
  resultText: string | RegExp;
};
type Scenario = {
  name: string;
  prompt: string;
  steps: readonly Step[];
  originalTask?: string;
  aborts?: boolean;
  notifications?: number;
  inactive?: boolean;
};

const timeoutMs = 20_000;
const finalText = "The local smoke scenario is complete.";
const fixtureText = "Owned Auto Mode smoke read fixture.\n";
const markerText = "Owned Auto Mode smoke write marker.\n";

function toolText(result: RecordValue) {
  const content = result.content;
  NodeAssert.ok(Array.isArray(content));
  return content.map((part) => record(part).text ?? "").join("\n");
}

function assertStepResult(result: RecordValue, step: Step, label: string) {
  NodeAssert.equal(result.isError, !step.executes, `${label}: native tool outcome`);
  const text = toolText(record(result.result));
  if (typeof step.resultText === "string") NodeAssert.ok(text.includes(step.resultText), text);
  else NodeAssert.match(text, step.resultText);
}

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

function launcherResolutionEnvironment(
  host: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const prefix = host.NPM_CONFIG_PREFIX || host.npm_config_prefix;
  const packageDirectories = [
    ...(prefix ? [platform === "win32" ? prefix : NodePath.join(prefix, "bin")] : []),
    ...(platform === "win32"
      ? resolveKnownWindowsCliDirs({
          APPDATA: host.APPDATA,
          LOCALAPPDATA: host.LOCALAPPDATA,
          USERPROFILE: host.USERPROFILE,
        })
      : []),
  ];
  return {
    PATH: [host.PATH || host.Path || "", ...packageDirectories]
      .filter(Boolean)
      .join(platform === "win32" ? ";" : ":"),
    ...(host.PATHEXT ? { PATHEXT: host.PATHEXT } : {}),
  };
}

async function resolveSmokeLaunch(
  command: string,
  args: readonly string[],
  host: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const environment = launcherResolutionEnvironment(host, platform);
  const resolveExecutable = await Effect.runPromise(SpawnExecutableResolution);
  const executable = resolveExecutable(command, platform, environment);
  NodeAssert.ok(executable, `Pi executable not found: ${command}`);
  const launch = await Effect.runPromise(
    resolveSpawnCommand(executable, args, { env: environment }),
  );
  if (!launch.shell) return launch;
  const sdkRoot = await Effect.runPromise(
    resolveNativePiSdkRoot({ binaryPath: executable, environment }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  NodeAssert.ok(
    sdkRoot,
    "Cannot bind the npm Pi launcher to a verified SDK; refusing an unowned shell child",
  );
  const manifest = record(
    JSON.parse(await NodeFSP.readFile(NodePath.join(sdkRoot, "package.json"), "utf8")),
  );
  const bin = typeof manifest.bin === "string" ? manifest.bin : record(manifest.bin).pi;
  NodeAssert.ok(typeof bin === "string");
  const cli = await NodeFSP.realpath(NodePath.join(sdkRoot, bin));
  const nodeExecutable = await Effect.runPromise(HostProcessExecutablePath);
  const direct = await Effect.runPromise(
    resolveSpawnCommand(nodeExecutable, [cli, ...args], { env: environment }),
  );
  NodeAssert.equal(
    direct.shell,
    false,
    "The verified Pi SDK must run in a directly owned Node process",
  );
  return direct;
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
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      await bounded(this.closed, "owned Pi already exited");
      return;
    }
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

async function verifyWindowsNpmLauncher(
  workspace: string,
  agentDirectory: string,
  environment: NodeJS.ProcessEnv,
  owned: NativeRpc[],
) {
  const hostAppdata = NodePath.join(workspace, "host npm profile & spaces");
  const prefix = NodePath.join(hostAppdata, "npm");
  const sdkRoot = NodePath.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
  const cliDirectory = NodePath.join(
    prefix,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
  );
  await NodeFSP.mkdir(cliDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(prefix, "pi.cmd"),
    [
      "@ECHO off",
      "SETLOCAL",
      'SET "dp0=%~dp0"',
      'IF EXIST "%dp0%node.exe" (',
      '  SET "_prog=%dp0%node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      ")",
      '"%_prog%" "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*',
      "",
    ].join("\r\n"),
  );
  await NodeFSP.writeFile(
    NodePath.join(sdkRoot, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.1.0",
      bin: { pi: "dist/cli.js" },
    }),
  );
  await NodeFSP.mkdir(NodePath.join(sdkRoot, "dist", "core"));
  for (const name of ["auth-storage.js", "model-runtime.js"])
    await NodeFSP.writeFile(NodePath.join(sdkRoot, "dist", "core", name), "");
  await NodeFSP.writeFile(
    NodePath.join(cliDirectory, "cli.js"),
    `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { pid: process.pid, args: process.argv.slice(2), home: process.env.HOME, profile: process.env.USERPROFILE, appdata: process.env.APPDATA, agentDirectory: process.env.PI_CODING_AGENT_DIR, hostOnlyAbsent: process.env.SMOKE_HOST_ONLY === undefined, prefixAbsent: process.env.NPM_CONFIG_PREFIX === undefined && process.env.npm_config_prefix === undefined, apiKeyAbsent: process.env.OPENAI_API_KEY === undefined } }) + "\\n");
});
`,
  );
  const args = ["--owned-npm-probe", "argument with spaces & punctuation"];
  const nodeExecutable = await Effect.runPromise(HostProcessExecutablePath);
  const host = {
    PATH: "",
    PATHEXT: environment.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    SMOKE_HOST_ONLY: "owned synthetic value",
  };
  const hosts: NodeJS.ProcessEnv[] = [
    { ...host, NPM_CONFIG_PREFIX: prefix },
    { ...host, npm_config_prefix: prefix },
    { ...host, APPDATA: hostAppdata },
  ];
  for (const lookup of hosts) {
    const resolved = await resolveSmokeLaunch("pi", args, lookup, "win32");
    NodeAssert.equal(resolved.shell, false);
    NodeAssert.equal(resolved.command, nodeExecutable);
    NodeAssert.deepEqual(resolved.args, [NodePath.join(cliDirectory, "cli.js"), ...args]);
  }
  const launch = await resolveSmokeLaunch(NodePath.join(prefix, "pi.cmd"), args, host, "win32");
  const probe = new NativeRpc(
    NodeChildProcess.spawn(launch.command, [...launch.args], {
      cwd: workspace,
      env: environment,
      shell: launch.shell,
      windowsHide: true,
      stdio: "pipe",
    }),
  );
  owned.push(probe);
  try {
    const result = record(await probe.request({ type: "get_state" }));
    NodeAssert.equal(
      result.pid,
      probe.child.pid,
      "The npm SDK must execute in the captured child, not a shell grandchild",
    );
    NodeAssert.deepEqual(result.args, args);
    NodeAssert.equal(result.home, workspace);
    NodeAssert.equal(result.profile, workspace);
    NodeAssert.equal(result.appdata, environment.APPDATA);
    NodeAssert.equal(result.agentDirectory, agentDirectory);
    NodeAssert.equal(result.hostOnlyAbsent, true);
    NodeAssert.equal(result.prefixAbsent, true);
    NodeAssert.equal(result.apiKeyAbsent, true);
  } finally {
    await probe.close();
  }
  console.log(
    "PASS owned npm pi.cmd: npm-prefix and APPDATA resolution, verified SDK entrypoint, isolated directly owned Node process",
  );
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
  const repositoryRoot = await NodeFSP.realpath(repository);
  const rootRelative = NodePath.relative(repositoryRoot, root);
  NodeAssert.ok(
    rootRelative &&
      !NodePath.isAbsolute(rootRelative) &&
      rootRelative !== ".." &&
      !rootRelative.startsWith(`..${NodePath.sep}`),
    "Smoke root must remain inside the repository",
  );
  const workspace = await NodeFSP.mkdtemp(NodePath.join(root, "run-"));
  const taskDirectory = NodePath.join(workspace, "task");
  const agentDirectory = NodePath.join(workspace, "agent");
  let rpc: NativeRpc | undefined;
  const owned: NativeRpc[] = [];
  let current: { scenario: Scenario; agentRequests: number; reviewRequests: number } | undefined;
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
        const step = current.scenario.steps[current.agentRequests - 1];
        NodeAssert.ok(
          step && (step.review !== undefined || step.unavailable),
          "Unexpected reviewer call for routine builtin",
        );
        current.reviewRequests++;
        const reviewPrompt = JSON.stringify(body.messages);
        NodeAssert.ok(reviewPrompt.includes(step.tool), "Reviewer did not receive the tool");
        const escapedPath = JSON.stringify(step.path).slice(1, -1);
        NodeAssert.ok(
          reviewPrompt.includes(escapedPath) ||
            reviewPrompt.includes(JSON.stringify(escapedPath).slice(1, -1)),
          "Reviewer did not receive the owned path",
        );
        const reviewMessages = (body.messages as unknown[]).map(record);
        const payloadMessage = reviewMessages.findLast((message) => message.role === "user");
        NodeAssert.ok(payloadMessage && typeof payloadMessage.content === "string");
        const payload = record(JSON.parse(payloadMessage.content));
        const actualUserMessages = payload.actualUserMessages;
        NodeAssert.ok(
          Array.isArray(actualUserMessages),
          "Reviewer must receive actual user messages",
        );
        const actualUserTexts = new Set(
          actualUserMessages.map((message) => {
            const userMessage = record(message);
            NodeAssert.equal(userMessage.role, "user");
            NodeAssert.equal(typeof userMessage.text, "string");
            return userMessage.text;
          }),
        );
        NodeAssert.ok(
          actualUserTexts.has(current.scenario.prompt),
          "Reviewer lost latest user message",
        );
        if (current.scenario.originalTask) {
          NodeAssert.ok(
            actualUserTexts.has(current.scenario.originalTask),
            "Continue lost original user task",
          );
          NodeAssert.equal(current.scenario.prompt, "continue");
        }
        NodeAssert.equal(payload.toolName, step.tool);
        NodeAssert.equal(record(payload.input).path, step.path);
        NodeAssert.equal(payload.cwd, taskDirectory);
        if (step.unavailable) {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Owned reviewer deliberately unavailable",
                type: "invalid_request_error",
                code: "model_not_found",
              },
            }),
          );
        } else sendSse(response, { content: step.review }, "stop");
        return;
      }
      const tools = (body.tools as unknown[]).map((tool) => record(record(tool).function).name);
      const systemMessage = (body.messages as unknown[])
        .map(record)
        .find((message) => message.role === "system");
      NodeAssert.ok(systemMessage && typeof systemMessage.content === "string");
      NodeAssert.equal(
        systemMessage.content.includes("<desktop_auto_mode>"),
        !current.scenario.inactive,
        "Autonomy guidance must be active-only",
      );
      NodeAssert.ok(
        tools.includes("read") && tools.includes("write"),
        "Native builtin tools missing",
      );
      NodeAssert.equal(tools.length, 2, "Only owned read/write tools may be enabled");
      NodeAssert.ok(
        ++current.agentRequests <= current.scenario.steps.length + 1,
        "Unexpected autonomous loop",
      );
      const stepIndex = current.agentRequests - 1;
      if (stepIndex > 0) {
        const previousStep = current.scenario.steps[stepIndex - 1]!;
        const toolResults = (body.messages as unknown[])
          .map(record)
          .filter((message) => message.role === "tool");
        const previousCallId = `call-${current.scenario.name}-${stepIndex - 1}`;
        const previousResult = toolResults.find(
          (message) => message.tool_call_id === previousCallId,
        );
        NodeAssert.ok(
          previousResult && typeof previousResult.content === "string",
          "Agent did not receive previous native tool result",
        );
        if (typeof previousStep.resultText === "string")
          NodeAssert.ok(
            previousResult.content.includes(previousStep.resultText),
            previousResult.content,
          );
        else NodeAssert.match(previousResult.content, previousStep.resultText);
      }
      if (stepIndex === current.scenario.steps.length) {
        NodeAssert.ok(!current.scenario.aborts, "Denial breaker did not abort the native loop");
        sendSse(response, { content: finalText }, "stop");
        return;
      }
      const step = current.scenario.steps[stepIndex]!;
      const args =
        step.tool === "read" ? { path: step.path } : { path: step.path, content: markerText };
      sendSse(
        response,
        {
          tool_calls: [
            {
              index: 0,
              id: `call-${current.scenario.name}-${stepIndex}`,
              type: "function",
              function: { name: step.tool, arguments: JSON.stringify(args) },
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
    await NodeFSP.mkdir(taskDirectory);
    for (const directory of ["tmp", "appdata", "localappdata", "config", "cache"])
      await NodeFSP.mkdir(NodePath.join(workspace, directory));
    const platform = await Effect.runPromise(HostProcessPlatform);
    const environment = isolatedEnvironment(workspace, agentDirectory);
    if (platform === "win32")
      await verifyWindowsNpmLauncher(workspace, agentDirectory, environment, owned);
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
    const launch = await resolveSmokeLaunch(command, args, process.env, platform);
    NodeAssert.equal(launch.shell, false, "Pi must run as a directly owned process");
    rpc = new NativeRpc(
      NodeChildProcess.spawn(launch.command, [...launch.args], {
        cwd: taskDirectory,
        env: environment,
        shell: launch.shell,
        windowsHide: true,
        stdio: "pipe",
      }),
    );
    owned.push(rpc);
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

    const inputPath = NodePath.join(taskDirectory, "input.txt");
    const outputPath = NodePath.join(taskDirectory, "output.txt");
    const continuedPath = NodePath.join(workspace, "continued-marker.txt");
    const boundaryReadPath = NodePath.join(workspace, "boundary-read.txt");
    await NodeFSP.writeFile(inputPath, fixtureText);
    await NodeFSP.writeFile(boundaryReadPath, fixtureText);
    const originalTask = `Read ${inputPath}, write exactly ${JSON.stringify(markerText)} to ${outputPath}, then read it back to verify. When I say continue, write the same marker to the owned scratch file ${continuedPath} outside the task cwd.`;
    const safeRead: Step = {
      tool: "read",
      path: inputPath,
      executes: true,
      resultText: fixtureText.trim(),
    };
    const blockedWrite = (name: string, review: string, confirm = false): Step => ({
      tool: "write",
      path: NodePath.join(workspace, `${name}.txt`),
      review,
      confirm,
      executes: false,
      resultText: confirm
        ? /Auto Mode: tool approval declined/
        : /Auto Mode: review unavailable or invalid.*materially safer alternative/s,
    });
    const denied = (name: string): Step => ({
      ...blockedWrite(
        name,
        '{"decision":"deny","risk":"high","reason":"Do not write this marker. Use read on the task input instead."}',
      ),
      resultText: /Auto Mode: denied.*Use read/s,
    });
    const scenarios: readonly Scenario[] = [
      {
        name: "native-read-write-read",
        prompt: originalTask,
        steps: [
          safeRead,
          { tool: "write", path: outputPath, executes: true, resultText: "Successfully wrote" },
          { tool: "read", path: outputPath, executes: true, resultText: markerText.trim() },
        ],
      },
      {
        name: "continue-medium-boundary-write",
        prompt: "continue",
        originalTask,
        steps: [
          {
            tool: "write",
            path: continuedPath,
            review:
              '{"decision":"approve","risk":"medium","reason":"Original user task authorizes this owned scratch marker."}',
            executes: true,
            resultText: "Successfully wrote",
          },
        ],
      },
      {
        name: "low-boundary-read",
        prompt: `Read the owned scratch fixture ${boundaryReadPath} outside cwd.`,
        steps: [
          {
            tool: "read",
            path: boundaryReadPath,
            review: '{"decision":"approve","risk":"low","reason":"Harmless owned fixture read."}',
            executes: true,
            resultText: fixtureText.trim(),
          },
        ],
      },
      {
        name: "deny-then-safe-read",
        prompt: `Do not write ${NodePath.join(workspace, "denied-marker.txt")}. Read ${inputPath} instead and finish.`,
        steps: [denied("denied-marker"), safeRead],
      },
      {
        name: "ask-declined",
        prompt:
          "Check an owned scratch write with explicit approval, then finish without writing if declined.",
        steps: [
          blockedWrite(
            "ask-marker",
            '{"decision":"ask","risk":"medium","reason":"Ask the user before this owned scratch write."}',
            true,
          ),
        ],
      },
      {
        name: "high-declined",
        prompt:
          "Check a high-risk owned scratch write with explicit approval, then finish without writing if declined.",
        steps: [
          blockedWrite(
            "high-marker",
            '{"decision":"approve","risk":"high","reason":"High risk requires user approval."}',
            true,
          ),
        ],
      },
      {
        name: "invalid-json-no-confirmation",
        notifications: 1,
        prompt:
          "If review is invalid, do not write the scratch marker; use a safe read and finish.",
        steps: [
          blockedWrite("invalid-json-marker", "not a JSON review"),
          blockedWrite("invalid-json-marker-two", "still not a JSON review"),
          safeRead,
        ],
      },
      {
        name: "invalid-shape-no-confirmation",
        notifications: 1,
        prompt:
          "If the reviewer response has unexpected fields, do not write; use a safe read and finish.",
        steps: [
          blockedWrite(
            "invalid-shape-marker",
            '{"decision":"approve","risk":"low","reason":"Bad schema","extra":true}',
          ),
          safeRead,
        ],
      },
      {
        name: "unavailable-review-no-confirmation",
        notifications: 1,
        prompt:
          "If review is unavailable, do not write the scratch marker; use a safe read and finish.",
        steps: [
          { ...blockedWrite("unavailable-marker", ""), review: undefined, unavailable: true },
          safeRead,
        ],
      },
      {
        name: "native-denial-breaker",
        notifications: 1,
        prompt: `Never write scratch markers. Stop after repeated denials and wait for a new user task. The safe alternative is read ${inputPath}.`,
        steps: [
          denied("breaker-one"),
          denied("breaker-two"),
          { ...denied("breaker-three"), resultText: /^Operation aborted$/ },
        ],
        aborts: true,
      },
      {
        name: "native-abort-recovery",
        prompt: `After the stopped turn, read ${inputPath} and finish this new user task.`,
        steps: [safeRead],
      },
      {
        name: "inactive-native-task",
        prompt: "After turning Auto Mode off, write only the owned scratch marker and finish.",
        inactive: true,
        steps: [
          {
            tool: "write",
            path: NodePath.join(workspace, "inactive-marker.txt"),
            executes: true,
            resultText: "Successfully wrote",
          },
        ],
      },
    ];
    for (const scenario of scenarios) {
      if (scenario.inactive) {
        const deactivationStart = native.events.length;
        await native.request({
          type: "prompt",
          message: "/pi-desktop-policy-desktop-auto deactivate smoke-deactivation",
        });
        const deactivationAck = await native.wait(
          (event) =>
            event.type === "extension_ui_request" &&
            event.method === "notify" &&
            typeof event.message === "string" &&
            event.message.startsWith("PI_DESKTOP_POLICY_ACK:"),
          deactivationStart,
          "Auto Mode deactivation acknowledgement",
        );
        NodeAssert.deepEqual(
          JSON.parse(String(deactivationAck.message).slice("PI_DESKTOP_POLICY_ACK:".length)),
          {
            requestId: "smoke-deactivation",
            policyId: "desktop-auto",
            action: "deactivate",
            success: true,
          },
        );
      }
      for (const step of scenario.steps) if (step.tool === "write") await absent(step.path);
      current = { scenario, agentRequests: 0, reviewRequests: 0 };
      const start = native.events.length;
      await native.request({
        type: "prompt",
        message: scenario.prompt,
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
        const confirmationStep = scenario.steps[current.agentRequests - 1];
        NodeAssert.ok(confirmationStep?.confirm, `${scenario.name}: unexpected confirmation`);
        NodeAssert.equal(++confirmations, 1, `${scenario.name}: duplicate confirmation`);
        NodeAssert.equal(event.title, "Auto Mode: approve tool?");
        NodeAssert.equal(typeof event.id, "string");
        const confirmationText = String(event.message);
        NodeAssert.ok(
          confirmationText.includes(confirmationStep.path) ||
            confirmationText.includes(JSON.stringify(confirmationStep.path).slice(1, -1)),
          "Confirmation must identify the owned action",
        );
        native.send({ type: "extension_ui_response", id: event.id, confirmed: false });
      }
      NodeAssert.equal(
        confirmations,
        scenario.steps.filter((step) => step.confirm).length,
        `${scenario.name}: confirmation count`,
      );
      NodeAssert.equal(
        current.agentRequests,
        scenario.steps.length + (scenario.aborts ? 0 : 1),
        `${scenario.name}: agent request count`,
      );
      NodeAssert.equal(
        current.reviewRequests,
        scenario.steps.filter((step) => step.review !== undefined || step.unavailable).length,
        `${scenario.name}: reviewer request count`,
      );
      if (scenario.aborts) {
        const turnEvents = native.events.slice(start);
        NodeAssert.equal(
          turnEvents.filter((event) => event.type === "agent_end").length,
          1,
          `${scenario.name}: native turn must end once`,
        );
        const stopWarnings = turnEvents.filter(
          (event) =>
            event.type === "extension_ui_request" &&
            event.method === "notify" &&
            typeof event.message === "string" &&
            event.message.startsWith("Auto Mode stopped this turn after repeated denials"),
        );
        NodeAssert.equal(stopWarnings.length, 1, `${scenario.name}: visible stop warning missing`);
        NodeAssert.equal(
          stopWarnings[0]!.notifyType,
          "warning",
          `${scenario.name}: stop notification must be a warning`,
        );
      }
      const results = native.events
        .slice(start)
        .filter((event) => event.type === "tool_execution_end");
      NodeAssert.equal(
        results.length,
        scenario.steps.length,
        `${scenario.name}: native tool result count`,
      );
      const messages = record(await native.request({ type: "get_messages" })).messages;
      NodeAssert.ok(Array.isArray(messages));
      for (const [stepIndex, step] of scenario.steps.entries()) {
        const result = results[stepIndex]!;
        const callId = `call-${scenario.name}-${stepIndex}`;
        NodeAssert.equal(result.toolName, step.tool);
        NodeAssert.equal(result.toolCallId, callId);
        assertStepResult(result, step, `${scenario.name}/${stepIndex}`);
        const toolResults: RecordValue[] = messages
          .map(record)
          .filter((message) => message.role === "toolResult" && message.toolCallId === callId);
        NodeAssert.equal(toolResults.length, 1, `${scenario.name}: persisted native tool result`);
        NodeAssert.equal(toolResults[0]!.isError, !step.executes);
        if (step.tool === "write") {
          if (step.executes)
            NodeAssert.equal(await NodeFSP.readFile(step.path, "utf8"), markerText);
          else await absent(step.path);
        } else
          NodeAssert.equal(
            await NodeFSP.readFile(step.path, "utf8"),
            step.path === outputPath ? markerText : fixtureText,
          );
      }
      const finalMessage = record(messages.at(-1));
      if (!scenario.aborts)
        NodeAssert.ok(
          finalMessage.role === "assistant" &&
            Array.isArray(finalMessage.content) &&
            finalMessage.content.some((part) => record(part).text === finalText),
          `${scenario.name}: final assistant response missing`,
        );
      NodeAssert.equal(
        record(await native.request({ type: "get_state" })).isStreaming,
        false,
        `${scenario.name}: native loop must be idle`,
      );
      NodeAssert.equal(
        native.events
          .slice(start)
          .filter((event) => event.type === "extension_ui_request" && event.method === "notify")
          .length,
        scenario.notifications ?? 0,
        `${scenario.name}: unexpected user notification spam`,
      );
      console.log(
        `PASS ${scenario.name}: steps=${scenario.steps.length}; reviews=${current.reviewRequests}; confirmations=${confirmations}${scenario.aborts ? "; native loop aborted" : "; task completed"}`,
      );
      current = undefined;
    }
    NodeAssert.equal(serverFailure, undefined);
    NodeAssert.equal(
      requests.length,
      scenarios.reduce(
        (total, scenario) =>
          total +
          scenario.steps.length +
          (scenario.aborts ? 0 : 1) +
          scenario.steps.filter((step) => step.review !== undefined || step.unavailable).length,
        0,
      ),
    );
    console.log(
      `PASS ${scenarios.length} scenarios; ${requests.length} owned loopback requests; no paid calls`,
    );
  } catch (error) {
    if (rpc?.stderr) console.error(`Owned Pi stderr: ${rpc.stderr}`);
    throw error;
  } finally {
    try {
      for (const process of owned) await process.close();
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
          owned.every(
            (process) => process.child.exitCode !== null || process.child.signalCode !== null,
          ),
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
