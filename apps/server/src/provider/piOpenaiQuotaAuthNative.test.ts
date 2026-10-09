import { describe, expect, it, vi } from "vite-plus/test";
import { PI_OPENAI_QUOTA_AUTH_OPERATION_SOURCE } from "./piOpenaiQuotaAuthNative.ts";

const runOperation = new Function(
  `${PI_OPENAI_QUOTA_AUTH_OPERATION_SOURCE}; return runOpenaiQuotaAuth;`,
)() as (options: unknown) => Promise<void>;
const secret = "NEVER_EXPORT_NATIVE_QUOTA_TOKEN";
const credential = {
  type: "oauth",
  access: secret,
  refresh: secret,
  expires: 4102444800000,
  accountId: "synthetic-account",
};
const fixture = (
  options: {
    consent?: boolean;
    action?: string;
    signal?: AbortSignal;
    login?: (interaction: {
      signal: AbortSignal;
      prompt: (prompt: unknown) => Promise<string>;
      notify: (event: unknown) => void;
    }) => Promise<unknown>;
    baseUrl?: string;
  } = {},
) => {
  const events: unknown[] = [];
  const store = {
    modify: vi.fn(async (_provider: string, update: () => unknown) => update()),
    delete: vi.fn(async () => {}),
  };
  const pending = {};
  const login = vi.fn(
    async (
      _provider: string,
      _type: string,
      interaction: Parameters<NonNullable<typeof options.login>>[0],
    ) => {
      if (options.login) return options.login(interaction);
      expect(
        await interaction.prompt({
          type: "select",
          options: [{ id: "browser" }, { id: "device_code" }],
        }),
      ).toBe("device_code");
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return credential;
    },
  );
  const AuthStorage = { create: vi.fn(() => store), inMemory: vi.fn(() => pending) };
  const ModelRuntime = {
    create: vi.fn(async () => ({
      getProvider: () => ({
        id: "openai-codex",
        baseUrl: options.baseUrl ?? "https://chatgpt.com/backend-api",
        auth: { oauth: { isSubscription: true } },
      }),
      login,
    })),
  };
  const signal = options.signal ?? new AbortController().signal;
  const task = runOperation({
    input: {
      consent: options.consent ?? true,
      action: options.action ?? "login",
      agentDir: "synthetic/native/profile",
    },
    AuthStorage,
    ModelRuntime,
    join: (...parts: string[]) => parts.join("/"),
    signal,
    emit: (event: unknown) => events.push(event),
  });
  return { task, events, store, AuthStorage, ModelRuntime, login, pending, signal };
};

describe("native Pi OpenAI quota authorization", () => {
  it("uses device authorization, stages secrets in memory and writes only the native legacy quota credential", async () => {
    const result = fixture();
    await result.task;
    expect(result.ModelRuntime.create).toHaveBeenCalledWith({
      credentials: result.pending,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
      signal: result.signal,
    });
    expect(result.login).toHaveBeenCalledWith(
      "openai-codex",
      "oauth",
      expect.objectContaining({ signal: result.signal }),
      { agentName: "Pi" },
    );
    expect(result.store.modify).toHaveBeenCalledOnce();
    expect(result.store.modify.mock.calls[0]?.[0]).toBe("openai-codex");
    expect(result.store.delete).not.toHaveBeenCalled();
    expect(result.events).toEqual([
      { type: "device_code", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" },
      { type: "complete", configured: true },
    ]);
    expect(JSON.stringify(result.events)).not.toContain(secret);
    expect(JSON.stringify(result.events)).not.toContain("synthetic-account");
  });

  it("requires explicit consent before opening native credential storage", async () => {
    const result = fixture({ consent: false });
    await expect(result.task).rejects.toThrow();
    expect(result.AuthStorage.create).not.toHaveBeenCalled();
    expect(result.ModelRuntime.create).not.toHaveBeenCalled();
    expect(result.events).toEqual([]);
  });

  it("does not persist a login returned after cancellation", async () => {
    const controller = new AbortController();
    const result = fixture({
      signal: controller.signal,
      login: async () => {
        controller.abort();
        return credential;
      },
    });
    await expect(result.task).rejects.toThrow();
    expect(result.store.modify).not.toHaveBeenCalled();
    expect(result.events).toEqual([]);
  });

  it("refuses custom quota hosts before login", async () => {
    const result = fixture({ baseUrl: "https://custom.invalid" });
    await expect(result.task).rejects.toThrow();
    expect(result.login).not.toHaveBeenCalled();
    expect(result.store.modify).not.toHaveBeenCalled();
  });

  it("refuses arbitrary auth URLs without forwarding their content", async () => {
    const result = fixture({
      login: async (interaction) => {
        interaction.notify({
          type: "device_code",
          verificationUri: `https://custom.invalid/${secret}`,
          userCode: "ABCD-EFGH",
        });
        return credential;
      },
    });
    await expect(result.task).rejects.toThrow();
    expect(result.events).toEqual([]);
    expect(result.store.modify).not.toHaveBeenCalled();
  });

  it("refuses browser/manual-code fallbacks rather than running another interactive flow", async () => {
    const result = fixture({
      login: async (interaction) => {
        await interaction.prompt({ type: "manual_code", message: secret });
        return credential;
      },
    });
    await expect(result.task).rejects.toThrow();
    expect(result.store.modify).not.toHaveBeenCalled();
  });

  it("requires quota account identity and the native device notification before saving", async () => {
    const result = fixture({
      login: async (interaction) => {
        interaction.notify({
          type: "device_code",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        });
        return { ...credential, accountId: undefined };
      },
    });
    await expect(result.task).rejects.toThrow();
    expect(result.store.modify).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
  });

  it("signs out only native quota OAuth without altering direct inference credentials", async () => {
    const result = fixture({ action: "logout" });
    await result.task;
    expect(result.store.delete).toHaveBeenCalledWith("openai-codex", { signal: result.signal });
    expect(result.ModelRuntime.create).not.toHaveBeenCalled();
    expect(result.store.modify).not.toHaveBeenCalled();
    expect(result.events).toEqual([{ type: "complete", configured: false }]);
  });
});
