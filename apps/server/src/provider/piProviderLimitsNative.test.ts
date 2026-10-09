import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { PiConnection } from "@t3tools/contracts";
import { makePiConnectionsExtensionSource } from "./piConnectionsExtension.ts";
import fixtureProviderLimits from "../../examples/pi-provider-limits.ts";

const key = "NEVER_EXPORT_NATIVE_KEY";
const decodeConnections = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(PiConnection)),
);
const decodeDiagnostic = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      authType: Schema.String,
      httpStatus: Schema.optionalKey(Schema.Int),
      metricCount: Schema.Int,
    }),
  ),
);
const model = (provider: string, baseUrl: string) => ({
  provider,
  baseUrl,
  id: "fixture",
  name: "Fixture",
});

const discover = async (
  models: Array<ReturnType<typeof model>>,
  options: {
    includeLimits?: boolean;
    openaiDiagnostic?: boolean;
    directTokenProbe?: boolean;
    diagnosticOutputOnly?: boolean;
    oauth?: boolean;
    authBaseUrl?: string;
    providerBaseUrl?: string;
    apiKey?: string;
    authHeaders?: Record<string, string>;
    throwDuringProbe?: boolean;
    quotaProviderAvailable?: boolean;
    register?: (request: { register: (service: string, reader: unknown) => void }) => void;
  } = {},
) => {
  const commands = new Map<string, { description: string }>();
  const providerReads = new Map<string, number>();
  const events = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const getApiKeyAndHeaders = vi.fn(async () => ({
    ok: true,
    apiKey: options.apiKey ?? key,
    ...(options.authBaseUrl ? { baseUrl: options.authBaseUrl } : {}),
  }));
  const getProviderAuth = vi.fn(async () => ({
    auth: {
      apiKey: options.apiKey ?? key,
      headers: options.authHeaders,
      ...(options.authBaseUrl ? { baseUrl: options.authBaseUrl } : {}),
    },
  }));
  const factory = new Function(
    makePiConnectionsExtensionSource(options.includeLimits !== false, {
      openaiDiagnostic:
        options.openaiDiagnostic ??
        (options.oauth === true && models.some((entry) => entry.provider === "openai")),
      diagnosticOutputOnly: options.diagnosticOutputOnly === true,
      directTokenProbe:
        options.directTokenProbe ?? options.openaiDiagnostic ?? options.oauth === true,
    }).replace("export default", "return"),
  )();
  factory({
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) =>
      events.set(name, handler),
    registerCommand: (name: string, command: { description: string }) =>
      commands.set(name, command),
    events: {
      emit: (_channel: string, request: { register: (service: string, reader: unknown) => void }) =>
        options.register?.(request),
    },
  });
  await events.get("session_start")!(undefined, {
    modelRegistry: {
      getAll: () => models,
      getAvailable: () => models,
      getProvider: (service: string) => {
        if (
          !models.some((entry) => entry.provider === service) &&
          !(service === "openai-codex" && options.quotaProviderAvailable)
        )
          return undefined;
        const count = (providerReads.get(service) ?? 0) + 1;
        providerReads.set(service, count);
        if (options.throwDuringProbe && count > 1) throw new Error(key);
        return {
          name: service,
          baseUrl:
            service === "openai-codex"
              ? "https://chatgpt.com/backend-api"
              : options.providerBaseUrl,
          auth: { apiKey: {}, oauth: {} },
        };
      },
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      isUsingOAuth: () => options.oauth === true,
      getApiKeyAndHeaders,
      getProviderAuth,
    },
  });
  const diagnosticDescription = commands.get("t3-openai-limits-diagnostic")?.description;
  if (options.diagnosticOutputOnly) {
    expect(diagnosticDescription).not.toContain("NEVER_EXPORT");
    return {
      connections: [],
      getApiKeyAndHeaders,
      getProviderAuth,
      diagnostic: decodeDiagnostic(diagnosticDescription),
      diagnosticDescription,
    };
  }
  const description = commands.get("t3-native-connections")!.description;
  expect(description).not.toContain("NEVER_EXPORT");
  const connections = decodeConnections(description);
  return {
    connections,
    getApiKeyAndHeaders,
    getProviderAuth,
    diagnostic: undefined,
    diagnosticDescription: undefined,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native Pi limits probes", () => {
  it("reads Venice balances and excludes configured inference rates", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              balances: { USD: -1.5, DIEM: 0, BUNDLED_CREDITS: 25 },
              rateLimits: [
                {
                  apiModelId: "fixture",
                  rateLimits: [
                    { type: "RPM", amount: 30 },
                    { type: "TPM", amount: 1000 },
                  ],
                },
              ],
              token: key,
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { connections } = await discover([model("venice", "https://api.venice.ai/api/v1")]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/api_keys/rate_limits",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      }),
    );
    const limits = connections[0]!.limitsDetails!;
    expect(limits.status).toBe("available");
    expect(connections[0]!.limits).toBe("available");
    expect(limits.metrics).toContainEqual({
      id: "balance-diem",
      label: "Diem balance",
      unit: "DIEM",
      remaining: 0,
    });
    expect(limits.metrics).toContainEqual({
      id: "balance-usd",
      label: "USD balance",
      unit: "USD",
      remaining: -1.5,
    });
    expect(limits.metrics).toHaveLength(3);
    expect(
      limits.metrics.every(
        (metric) => metric.remaining !== undefined && metric.limit === undefined,
      ),
    ).toBe(true);
  });

  it("reads OAuth subscription percentages and reset timestamps without scaling API percentages", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            five_hour: { utilization: 12.5, resets_at: "2026-10-08T18:00:00Z" },
            seven_day: null,
            extra_usage: { used_credits: 100 },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { connections } = await discover([model("anthropic", "https://api.anthropic.com")], {
      oauth: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
        },
      }),
    );
    expect(connections[0]!.limitsDetails!.metrics).toEqual([
      {
        id: "five_hour",
        label: "Five-hour subscription window",
        unit: "percent",
        used: 12.5,
        limit: 100,
        windowSeconds: 18000,
        resetsAt: "2026-10-08T18:00:00.000Z",
      },
    ]);
  });

  it("uses native legacy Codex account claims and raw window sizes", async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 42,
                limit_window_seconds: 18000,
                reset_at: 1791482400,
              },
            },
            credits: { balance: "9.99" },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { connections } = await discover(
      [model("openai-codex", "https://chatgpt.com/backend-api")],
      { oauth: true, apiKey: token },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "ChatGPT-Account-Id": "fixture-account",
        },
      }),
    );
    expect(connections[0]!.limitsDetails!.metrics[0]).toMatchObject({
      used: 42,
      limit: 100,
      windowSeconds: 18000,
    });
    expect(connections[0]!.limitsDetails!.metrics[1]).toMatchObject({
      remaining: 9.99,
      unit: "credits",
    });
  });

  it("queries new native OpenAI OAuth without inventing routing identity from encrypted claims", async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: "https://api.openai.com/v1", scope: "chatgpt.tokens.use.direct resource.invoke", "https://api.openai.com/auth": { per_user_salt: key, encrypted_auth_metadata: key } })).toString("base64url")}.fixture`;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 42,
                limit_window_seconds: 18000,
                reset_at: 1791482400,
              },
            },
            credits: { balance: "9.99" },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { connections, getProviderAuth, getApiKeyAndHeaders } = await discover(
      [model("openai", "https://api.openai.com/v1")],
      { oauth: true, apiKey: token },
    );
    expect(getProviderAuth).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        redirect: "error",
      }),
    );
    expect(connections[0]!.limitsDetails).toMatchObject({
      status: "available",
      source: "openai-private-oauth-api",
    });
    expect(connections[0]!.limitsDetails!.metrics[0]).toMatchObject({
      used: 42,
      limit: 100,
      windowSeconds: 18000,
    });
  });

  it("uses provider-scoped native routing headers for opaque OpenAI OAuth without forwarding arbitrary metadata", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { connections } = await discover([model("openai", "https://api.openai.com/v1")], {
      oauth: true,
      authHeaders: { "ChatGPT-Account-Id": "native-account", "x-private": key },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          "ChatGPT-Account-Id": "native-account",
        },
      }),
    );
    expect(connections[0]!.limitsDetails!.metrics[0]?.used).toBe(0);
  });

  it("does not forward new OpenAI credentials from custom or mismatched native endpoints", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const options of [
      { providerBaseUrl: "https://custom.invalid/v1" },
      { authBaseUrl: "https://custom.invalid/v1" },
    ]) {
      const { connections } = await discover([model("openai", "https://api.openai.com/v1")], {
        ...options,
        oauth: true,
      });
      expect(connections[0]!.limitsDetails!.status).toBe("unsupported");
    }
    const token = `fixture.${Buffer.from(JSON.stringify({ iss: "https://other.invalid", aud: "https://api.openai.com/v1" })).toString("base64url")}.fixture`;
    const { connections } = await discover([model("openai", "https://api.openai.com/v1")], {
      oauth: true,
      apiKey: token,
    });
    expect(connections[0]!.limitsDetails!.status).toBe("unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an actual OpenAI private endpoint refusal safely, not a fabricated quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(key, { status: 403 })),
    );
    const { connections } = await discover([model("openai", "https://api.openai.com/v1")], {
      oauth: true,
    });
    expect(connections[0]!.limitsDetails).toMatchObject({
      status: "error",
      metrics: [],
      message: "The provider limits request failed (HTTP 403).",
    });
  });

  it("does not resolve credentials or fetch during metadata discovery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { connections, getApiKeyAndHeaders } = await discover(
      [model("venice", "https://api.venice.ai/api/v1")],
      { includeLimits: false },
    );
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(connections[0]!.limitsDetails).toBeUndefined();
  });

  it("does not repeat the rejected OpenAI direct-token quota probe in normal refresh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { connections, getProviderAuth } = await discover(
      [model("openai", "https://api.openai.com/v1")],
      { oauth: true, openaiDiagnostic: false },
    );
    expect(connections[0]!.limitsDetails!.status).toBe("unsupported");
    expect(connections[0]!.limitsDetails!.message).toContain("HTTP 401");
    expect(connections[0]!.limitsDetails!.message).not.toContain("pending");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProviderAuth).not.toHaveBeenCalled();
  });

  it("reads separately authorized native quota OAuth without legacy models and never sends direct credentials", async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 18000 } },
            credits: { balance: "7.5" },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { connections, getProviderAuth } = await discover(
      [model("openai", "https://api.openai.com/v1")],
      { oauth: true, quotaProviderAvailable: true, openaiDiagnostic: false, apiKey: token },
    );
    expect(connections).toHaveLength(1);
    expect(connections[0]!.limitsDetails).toMatchObject({
      status: "available",
      source: "native-openai-separate-quota-oauth",
    });
    expect(connections[0]!.limitsDetails!.message).toContain("separately authorized");
    expect(connections[0]!.limitsDetails!.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: "percent", used: 17 }),
        expect.objectContaining({ remaining: 7.5 }),
      ]),
    );
    expect(getProviderAuth).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getProviderAuth).not.toHaveBeenCalledWith("openai", expect.anything());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not duplicate OpenAI subscription quota across direct and legacy rows", async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { connections } = await discover(
      [
        model("openai", "https://api.openai.com/v1"),
        model("openai-codex", "https://chatgpt.com/backend-api"),
      ],
      { oauth: true, openaiDiagnostic: false, apiKey: token },
    );
    expect(connections.map((entry) => entry.service)).toEqual(["openai"]);
    expect(connections[0]!.limitsDetails!.status).toBe("available");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves explicitly registered OpenAI extension reader priority over native quota OAuth", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { connections, getProviderAuth } = await discover(
      [model("openai", "https://api.openai.com/v1")],
      {
        oauth: true,
        quotaProviderAvailable: true,
        openaiDiagnostic: false,
        register: (request) =>
          request.register("openai", async () => ({
            metrics: [{ unit: "credits", remaining: 7.5 }],
          })),
      },
    );
    expect(connections[0]!.limitsDetails).toMatchObject({
      status: "available",
      source: "pi-extension",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProviderAuth).not.toHaveBeenCalled();
  });

  it("keeps the native quota failure reason alongside the separate-account disclosure", async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("NEVER_EXPORT_NATIVE_ERROR_BODY", { status: 403 })),
    );
    const { connections } = await discover([model("openai", "https://api.openai.com/v1")], {
      oauth: true,
      quotaProviderAvailable: true,
      openaiDiagnostic: false,
      apiKey: token,
    });
    expect(connections[0]!.limitsDetails).toMatchObject({
      status: "error",
      source: "native-openai-separate-quota-oauth",
    });
    expect(connections[0]!.limitsDetails!.message).toContain("HTTP 403");
    expect(connections[0]!.limitsDetails!.message).toContain("separately authorized");
  });

  it("default diagnostic verifies native quota OAuth rather than the rejected direct token", async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000 } },
            }),
          ),
      ),
    );
    const { diagnostic, getProviderAuth } = await discover(
      [model("openai", "https://api.openai.com/v1")],
      {
        oauth: true,
        quotaProviderAvailable: true,
        openaiDiagnostic: true,
        directTokenProbe: false,
        diagnosticOutputOnly: true,
        apiKey: token,
      },
    );
    expect(diagnostic).toEqual({
      status: "available",
      authType: "oauth",
      httpStatus: 200,
      metricCount: 1,
    });
    expect(getProviderAuth).toHaveBeenCalledWith("openai-codex", expect.anything());
    expect(getProviderAuth).not.toHaveBeenCalledWith("openai", expect.anything());
  });

  it("live diagnostic probes only OpenAI and exports counts/status without account or metric details", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000 } },
            credits: { balance: "9.99" },
            secret: key,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const registration = vi.fn();
    const { diagnostic, diagnosticDescription, getProviderAuth, getApiKeyAndHeaders } =
      await discover(
        [
          model("openai", "https://api.openai.com/v1"),
          model("venice", "https://api.venice.ai/api/v1"),
          model("anthropic", "https://api.anthropic.com"),
        ],
        {
          oauth: true,
          openaiDiagnostic: true,
          diagnosticOutputOnly: true,
          authHeaders: { "ChatGPT-Account-Id": "native-account" },
          register: registration,
        },
      );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProviderAuth).toHaveBeenCalledTimes(1);
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(registration).not.toHaveBeenCalled();
    expect(diagnostic).toEqual({
      status: "available",
      authType: "oauth",
      httpStatus: 200,
      metricCount: 2,
    });
    expect(diagnosticDescription).not.toContain("native-account");
    expect(diagnosticDescription).not.toContain("9.99");
    expect(diagnosticDescription).not.toContain("used_percent");
  });

  it("blocks custom model/provider/resolved endpoints before sending secrets", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const options of [
      {},
      { providerBaseUrl: "https://custom.invalid/v1" },
      { authBaseUrl: "https://custom.invalid/v1" },
    ]) {
      const baseUrl = Object.keys(options).length
        ? "https://api.venice.ai/api/v1"
        : "https://custom.invalid/v1";
      const { connections } = await discover([model("venice", baseUrl)], options);
      expect(connections[0]!.limitsDetails!.status).toBe("unsupported");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("separates API-only, unknown plugins and actual locals", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { connections, getApiKeyAndHeaders } = await discover([
      model("anthropic", "https://api.anthropic.com"),
      model("openai", "https://api.openai.com/v1"),
      model("pi-claude", "https://api.anthropic.com"),
      model("my-ollama-cloud", "https://custom.invalid/v1"),
      model("ollama", "http://localhost:11434/v1"),
      model("llamacpp", "http://127.0.0.1:8080/v1"),
      model("llamacpp-local", "http://127.0.0.1:8080/v1"),
    ]);
    expect(connections.map((connection) => connection.limitsDetails!.status)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
      "not_applicable",
      "not_applicable",
      "not_applicable",
    ]);
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates HTTP and parse failures without leaking response bodies or exceptions", async () => {
    for (const response of [
      new Response(key, { status: 401 }),
      new Response(key),
      new Response("{}"),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      const { connections } = await discover([model("venice", "https://api.venice.ai/api/v1")]);
      expect(connections[0]!.limitsDetails!.status).toBe("error");
    }
  });

  it("does not label cloud or mismatched provider endpoints as local based on the llamacpp-local ID", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cloud = await discover([model("llamacpp-local", "https://custom.invalid/v1")]);
    const mismatched = await discover([model("llamacpp-local", "http://127.0.0.1:8080/v1")], {
      providerBaseUrl: "https://custom.invalid/v1",
    });
    expect(cloud.connections[0]!.limitsDetails!.status).toBe("unsupported");
    expect(mismatched.connections[0]!.limitsDetails!.status).toBe("unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports only explicitly registered plugin capabilities with a safe wire projection", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { connections, getApiKeyAndHeaders } = await discover(
      [model("pi-claude", "https://custom.invalid")],
      {
        register: (request) =>
          request.register("pi-claude", async () => ({
            source: key,
            message: key,
            headers: { authorization: key },
            metrics: [
              { id: key, label: key, unit: "USD", remaining: 4 },
              { unit: "credits", remaining: Infinity },
            ],
          })),
      },
    );
    expect(connections[0]!.limitsDetails).toMatchObject({
      status: "available",
      source: "pi-extension",
      metrics: [{ id: "extension-1", label: "Extension metric 1", unit: "USD", remaining: 4 }],
    });
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("runs the documented opt-in fixture without any network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let collect: ((data: unknown) => void) | undefined;
    const provider = vi.fn();
    fixtureProviderLimits({
      registerProvider: provider,
      events: {
        on: (_channel: string, handler: (data: unknown) => void) => {
          collect = handler;
        },
      },
    } as unknown as Parameters<typeof fixtureProviderLimits>[0]);
    expect(provider).toHaveBeenCalledWith("t3-limits-fixture", expect.any(Object));
    const { connections } = await discover([model("t3-limits-fixture", "http://127.0.0.1:1/v1")], {
      register: (request) => collect!(request),
    });
    expect(connections[0]!.limitsDetails).toMatchObject({
      status: "available",
      source: "pi-extension",
      metrics: [{ unit: "credits", remaining: 7.5 }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds concurrency and stops uncooperative plugin readers at the global deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) =>
      duration === 12000 ? deadline.signal : new AbortController().signal,
    );
    const reader = vi.fn(() => new Promise(() => {}));
    const models = Array.from({ length: 5 }, (_unused, index) =>
      model(`fixture-${index}`, "https://custom.invalid"),
    );
    const pending = discover(models, {
      register: (request) => models.forEach((entry) => request.register(entry.provider, reader)),
    });
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(3));
    deadline.abort();
    const { connections } = await pending;
    expect(reader).toHaveBeenCalledTimes(3);
    expect(connections.every((connection) => connection.limitsDetails!.status === "error")).toBe(
      true,
    );
  });

  it("ignores malformed Venice configured rates without discarding balances", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                balances: { USD: 0 },
                rateLimits: [{ apiModelId: "  ", rateLimits: [{ type: "RPM", amount: 5 }] }],
              },
            }),
          ),
      ),
    );
    const { connections } = await discover([model("venice", "https://api.venice.ai/api/v1")]);
    expect(connections[0]!.limitsDetails!.status).toBe("available");
    expect(connections[0]!.limitsDetails!.metrics).toEqual([
      { id: "balance-usd", label: "USD balance", unit: "USD", remaining: 0 },
    ]);
  });

  it("isolates unexpected registry probe failures and throwing collection handlers", async () => {
    const failed = await discover([model("venice", "https://api.venice.ai/api/v1")], {
      throwDuringProbe: true,
    });
    expect(failed.connections[0]!.limitsDetails!.status).toBe("error");
    const unsupported = await discover([model("custom", "https://custom.invalid")], {
      register: () => {
        throw new Error(key);
      },
    });
    expect(unsupported.connections[0]!.limitsDetails!.status).toBe("unsupported");
  });
});
