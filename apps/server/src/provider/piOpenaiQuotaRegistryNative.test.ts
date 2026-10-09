import { describe, expect, it, vi } from "vite-plus/test";
import { PI_OPENAI_QUOTA_REGISTRY_NATIVE_SOURCE } from "./piOpenaiQuotaRegistryNative.ts";

const createRegistry = new Function(
  `${PI_OPENAI_QUOTA_REGISTRY_NATIVE_SOURCE}; return createNativeOpenaiQuotaRegistry;`,
)() as (
  options: unknown,
) => Promise<
  { getProviderAuth: (provider: string, options: unknown) => Promise<unknown> } | undefined
>;

const fixture = (entries: unknown[], baseUrl = "https://chatgpt.com/backend-api") => {
  const signal = new AbortController().signal;
  const list = vi.fn(async () => entries);
  const credentials = { list };
  const getAuth = vi.fn(async () => ({ auth: { apiKey: "NATIVE_SECRET_ONLY" } }));
  const getProvider = vi.fn(() => ({
    id: "openai-codex",
    baseUrl,
    auth: { oauth: { isSubscription: true } },
  }));
  const ModelRuntime = { create: vi.fn(async () => ({ getAuth, getProvider })) };
  const AuthStorage = { create: vi.fn(() => credentials) };
  const task = createRegistry({
    AuthStorage,
    ModelRuntime,
    agentDir: "synthetic/native/profile",
    join: (...parts: string[]) => parts.join("/"),
    signal,
  });
  return { task, list, credentials, getAuth, getProvider, ModelRuntime, AuthStorage, signal };
};

describe("native OpenAI quota credential discovery", () => {
  it("checks metadata and refuses missing native quota OAuth without resolving any credential", async () => {
    const result = fixture([
      { providerId: "openai", type: "oauth" },
      { providerId: "openai-codex", type: "api_key" },
    ]);
    expect(await result.task).toBeUndefined();
    expect(result.ModelRuntime.create).not.toHaveBeenCalled();
    expect(result.getAuth).not.toHaveBeenCalled();
  });

  it("uses the selected native store and refresh-aware getAuth, even without registry models", async () => {
    const result = fixture([{ providerId: "openai-codex", type: "oauth" }]);
    const registry = await result.task;
    expect(result.AuthStorage.create).toHaveBeenCalledWith("synthetic/native/profile/auth.json");
    expect(result.ModelRuntime.create).toHaveBeenCalledWith({
      credentials: result.credentials,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
      signal: result.signal,
    });
    expect(result.getAuth).not.toHaveBeenCalled();
    expect(await registry!.getProviderAuth("openai-codex", { signal: result.signal })).toEqual({
      auth: { apiKey: "NATIVE_SECRET_ONLY" },
    });
    expect(result.getAuth).toHaveBeenCalledWith("openai-codex", { signal: result.signal });
    expect(registry!.getProviderAuth("openai", {})).toBeUndefined();
  });

  it("does not resolve custom-host quota credentials", async () => {
    const result = fixture(
      [{ providerId: "openai-codex", type: "oauth" }],
      "https://custom.invalid",
    );
    expect(await result.task).toBeUndefined();
    expect(result.getAuth).not.toHaveBeenCalled();
  });
});
