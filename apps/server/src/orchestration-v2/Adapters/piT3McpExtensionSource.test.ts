import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import {
  PI_T3_MCP_EXTENSION_SOURCE,
  PI_RUNTIME_POLICY_STATE_COMMAND,
} from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly exposure?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly execute: (
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  }>;
}

type AgentStartHook = (
  event: { systemPrompt: string },
  ctx: { ui: { notify: (message: string, severity: string) => void } },
) => Promise<{ systemPrompt: string }>;

async function loadMcpBridge(
  options: {
    readonly modern?: boolean;
    readonly toolSearchAvailable?: boolean;
    readonly toolSearchDisabled?: boolean;
    readonly allowsTool?: (name: string) => boolean;
  } = {},
) {
  const handlers = new Map<string, AgentStartHook>();
  const tools: RegisteredTool[] = [];
  const requests: Array<{ readonly method: string; readonly params?: unknown }> = [];
  let activeTools = ["read"];
  const transports: Array<{
    readonly url: string;
    readonly authorization: string;
    readonly signal: AbortSignal | undefined;
  }> = [];
  const servers: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
  const catalog = [
    { name: "orchestrator_capabilities", description: "Discover available providers and models." },
    { name: "delegate_task", description: "Delegate work to another agent." },
    { name: "task_status", description: "Check delegated work." },
    { name: "preview_snapshot", description: "Inspect the collaborative browser." },
  ].map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } }));
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: {
      env: { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture-token" },
    },
    AbortSignal,
    Type: { Unsafe: (schema: unknown) => schema },
    fetch: async (
      url: string,
      options: { body: string; headers: Record<string, string>; signal?: AbortSignal },
    ) => {
      transports.push({
        url,
        authorization: options.headers.authorization!,
        signal: options.signal,
      });
      const request = JSON.parse(options.body) as { id: number; method: string; params?: unknown };
      requests.push(request);
      const result =
        request.method === "tools/list"
          ? { tools: catalog }
          : request.method === "tools/call"
            ? { content: [{ type: "text", text: "browser snapshot" }] }
            : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
    pi: {
      registerCommand: () => undefined,
      on: (name: string, handler: AgentStartHook) => handlers.set(name, handler),
      registerTool: (tool: RegisteredTool) => {
        if (options.allowsTool && !options.allowsTool(tool.name)) return;
        const index = tools.findIndex((current) => current.name === tool.name);
        if (index === -1) tools.push(tool);
        else tools[index] = tool;
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names.filter((name) => options.allowsTool?.(name) ?? true);
      },
      getAllTools: () =>
        options.toolSearchAvailable &&
        !options.toolSearchDisabled &&
        (options.allowsTool?.("tool_search") ?? true)
          ? [{ name: "tool_search", sourceInfo: { path: "builtin:tool-search" } }]
          : [],
      ...(options.modern
        ? {
            registerMcpServer: (name: string, config: Record<string, unknown>) =>
              servers.push({ name, config }),
            unregisterMcpServer: () => servers.splice(0),
          }
        : {}),
    },
  });
  return {
    handlers,
    tools,
    requests,
    servers,
    transports,
    getActiveTools: () => activeTools,
    restoreActiveTools: (names: string[]) => {
      activeTools = names;
    },
  };
}

describe("Pi MCP tool exposure", () => {
  it("keeps orchestration direct and optional bridge tools discoverable on modern Pi", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { ui: { notify: () => undefined } },
    );
    const start = bridge.handlers.get("before_agent_start");
    assert.isDefined(start);
    const prompt = await start!(
      { systemPrompt: "Pi system prompt" },
      { ui: { notify: () => undefined } },
    );
    assert.include(prompt.systemPrompt, "orchestrator_capabilities");
    assert.equal(bridge.servers.length, 0);
    assert.equal(bridge.tools.length, 8);
    assert.deepEqual(bridge.getActiveTools(), ["read", "tool_search"]);
    assert.deepEqual(
      bridge.tools
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => [tool.name, tool.exposure]),
      [
        ["mcp__t3-code__orchestrator_capabilities", "direct"],
        ["mcp__t3-code__delegate_task", "direct"],
        ["mcp__t3-code__task_status", "direct"],
        ["mcp__t3-code__preview_snapshot", "deferred"],
      ],
    );
    assert.deepEqual(
      bridge.tools.filter((tool) => tool.exposure === "hidden").map((tool) => tool.name),
      [
        "mcp__t3_code__orchestrator_capabilities",
        "mcp__t3_code__delegate_task",
        "mcp__t3_code__task_status",
        "mcp__t3_code__preview_snapshot",
      ],
    );
    const result = await bridge.tools
      .find((tool) => tool.name === "mcp__t3-code__preview_snapshot")!
      .execute("call-1", { depth: 2 });
    assert.equal(result.content[0]?.text, "browser snapshot");
    assert.equal(bridge.requests.at(-1)?.method, "tools/call");
  });

  it.each(["legacy Pi", "disabled tool search"])(
    "keeps tool execution available with %s",
    async (mode) => {
      const bridge = await loadMcpBridge({
        modern: mode !== "legacy Pi",
        toolSearchAvailable: mode === "disabled tool search",
        toolSearchDisabled: mode === "disabled tool search",
      });
      if (mode !== "legacy Pi") {
        const start = bridge.handlers.get("session_start");
        await start!({ systemPrompt: "Pi system prompt" }, { ui: { notify: () => undefined } });
      }
      assert.equal(bridge.tools.filter((tool) => tool.exposure !== "hidden").length, 4);
      assert.isTrue(
        bridge.tools
          .filter((tool) => tool.exposure !== "hidden")
          .every((tool) => tool.exposure === undefined || tool.exposure === "direct"),
      );
      const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot");
      assert.isDefined(tool);
      const controller = new AbortController();
      const result = await tool!.execute("call-1", { depth: 2 }, controller.signal);
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.strictEqual(bridge.transports.at(-1)?.signal, controller.signal);
      assert.equal(bridge.transports.at(-1)?.url, "http://fixture.invalid/mcp");
      assert.equal(bridge.transports.at(-1)?.authorization, "Bearer fixture-token");
      assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1))), {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: { depth: 2 } },
      });
      assert.isUndefined(tool?.promptSnippet);
      assert.isUndefined(tool?.promptGuidelines);
    },
  );

  it("preserves legacy wildcard tool selection", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      allowsTool: (name) =>
        name === "read" || name === "tool_search" || name.startsWith("mcp__t3-code__"),
    });
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { ui: { notify: () => undefined } },
    );
    assert.equal(bridge.tools.length, 4);
    assert.equal(bridge.tools.filter((tool) => tool.exposure === "direct").length, 3);
    const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot");
    assert.isDefined(tool);
    assert.equal((await tool!.execute("selected", {})).content[0]?.text, "browser snapshot");
  });

  it.each([false, true])(
    "reconciles tree loadouts while honoring search exclusion: %s",
    async (excludeSearch) => {
      const bridge = await loadMcpBridge({
        modern: true,
        toolSearchAvailable: true,
        allowsTool: (name) =>
          name !== "mcp__t3-code__delegate_task" && (!excludeSearch || name !== "tool_search"),
      });
      await bridge.handlers.get("session_start")!(
        { systemPrompt: "" },
        { ui: { notify: () => undefined } },
      );
      bridge.restoreActiveTools([
        "read",
        "mcp__t3-code__task_status",
        "mcp__t3-code__preview_snapshot",
      ]);
      const tree = bridge.handlers.get("session_tree");
      assert.isDefined(tree);
      await tree!({ systemPrompt: "" }, { ui: { notify: () => undefined } });
      assert.deepEqual(bridge.getActiveTools(), [
        "read",
        "mcp__t3-code__task_status",
        "mcp__t3-code__preview_snapshot",
        ...(!excludeSearch ? ["tool_search"] : []),
      ]);
      assert.isFalse(
        bridge.tools.some(
          (tool) => tool.exposure !== "hidden" && tool.name.endsWith("__delegate_task"),
        ),
      );
    },
  );
});

describe("Pi tool discovery permissions", () => {
  async function loadPolicyGuard(mode: string) {
    type ToolHook = (
      event: { toolName: string; input: unknown },
      ctx: {
        ui: { confirm: () => Promise<boolean> };
      },
    ) => Promise<{ block: boolean } | undefined>;
    let toolHook: ToolHook | undefined;
    const sessionHooks: Array<() => void> = [];
    let stateCommand:
      | ((args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>)
      | undefined;
    const source = NodeModule.stripTypeScriptTypes(
      PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
        "export default async function",
        "async function",
      ),
    );
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: { env: { T3_PI_RUNTIME_MODE: mode, T3_PI_POLICY_TOKEN: "secret" } },
      pi: {
        on: (name: string, handler: ToolHook) => {
          if (name === "tool_call") toolHook = handler;
          if (name === "session_start") sessionHooks.push(handler as unknown as () => void);
        },
        registerCommand: (name: string, command: { handler: typeof stateCommand }) => {
          assert.equal(name, PI_RUNTIME_POLICY_STATE_COMMAND);
          stateCommand = command.handler;
        },
      },
    });
    return { toolHook: toolHook!, stateCommand: stateCommand!, reset: sessionHooks[0]! };
  }

  it.each([
    ["approval-required", "read", 0],
    ["approval-required", "edit", 1],
    ["approval-required", "bash", 1],
    ["auto-accept-edits", "write", 0],
    ["auto-accept-edits", "bash", 1],
    ["full-access", "bash", 0],
    ["full-access", "custom-extension-tool", 0],
  ] as const)("preserves base mode %s for %s", async (mode, toolName, count) => {
    const guard = await loadPolicyGuard(mode);
    let confirmations = 0;
    const result = await guard.toolHook(
      { toolName, input: {} },
      {
        ui: {
          confirm: async () => {
            confirmations += 1;
            return false;
          },
        },
      },
    );
    assert.equal(confirmations, count);
    assert.equal(result?.block ?? false, count > 0);
  });

  it("blocks every Auto tool until the authenticated state command and resets on native sessions", async () => {
    const guard = await loadPolicyGuard("auto");
    const ctx = {
      ui: {
        confirm: async () => {
          throw new Error("Auto must not use builtin confirmation fallback");
        },
      },
    };
    const notices: string[] = [];
    const commandCtx = { ui: { notify: (message: string) => notices.push(message) } };
    assert.equal((await guard.toolHook({ toolName: "read", input: {} }, ctx))?.block, true);
    await guard.stateCommand("wrong auto example-auto request-1", commandCtx);
    assert.equal(notices.length, 0);
    assert.equal((await guard.toolHook({ toolName: "bash", input: {} }, ctx))?.block, true);
    await guard.stateCommand("secret auto example-auto request-2", commandCtx);
    assert.include(notices[0]!, '"requestId":"request-2"');
    assert.isUndefined(await guard.toolHook({ toolName: "bash", input: {} }, ctx));
    guard.reset();
    assert.equal((await guard.toolHook({ toolName: "write", input: {} }, ctx))?.block, true);
  });

  it("allows discovery without confirmation and still gates the discovered tool", async () => {
    type ToolCallHook = (
      event: { toolName: string; input: unknown },
      ctx: { ui: { confirm: (title: string, detail: string) => Promise<boolean> } },
    ) => Promise<{ block: true; reason: string } | undefined>;
    let toolCall: ToolCallHook | undefined;
    let searchPath = "builtin:tool-search";
    const source = NodeModule.stripTypeScriptTypes(
      PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
        "export default async function",
        "async function",
      ),
    );
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: { env: { T3_PI_RUNTIME_MODE: "approval-required" } },
      pi: {
        registerCommand: () => undefined,
        on: (name: string, handler: ToolCallHook) => {
          if (name === "tool_call") toolCall = handler;
        },
        getAllTools: () => [{ name: "tool_search", sourceInfo: { path: searchPath } }],
      },
    });
    assert.isDefined(toolCall);
    const confirmations: string[] = [];
    const ctx = {
      ui: {
        confirm: async (title: string) => {
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(
      await toolCall!({ toolName: "tool_search", input: { query: "preview_snapshot" } }, ctx),
    );
    assert.equal(confirmations.length, 0);
    const result = await toolCall!({ toolName: "mcp__t3-code__preview_snapshot", input: {} }, ctx);
    assert.equal(result?.block, true);
    assert.deepEqual(confirmations, ["Allow mcp__t3-code__preview_snapshot?"]);

    // An extension that replaces the search builtin is not known to be read-only.
    searchPath = "/extensions/custom-search.ts";
    const replaced = await toolCall!({ toolName: "tool_search", input: {} }, ctx);
    assert.equal(replaced?.block, true);
    assert.equal(confirmations.at(-1), "Allow tool_search?");
  });
});

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: {
      registerCommand: () => undefined,
      on: (name: string, handler: RequestHook) => handlers.set(name, handler),
    },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});
