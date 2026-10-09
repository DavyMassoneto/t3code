export const PI_OPENAI_QUOTA_REGISTRY_NATIVE_SOURCE = String.raw`
async function createNativeOpenaiQuotaRegistry({AuthStorage, ModelRuntime, agentDir, join, signal}) {
  signal.throwIfAborted();
  const credentials = AuthStorage.create(join(agentDir, "auth.json"));
  const entries = await credentials.list({signal});
  if (!entries.some(entry => entry.providerId === "openai-codex" && entry.type === "oauth")) return undefined;
  const runtime = await ModelRuntime.create({credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal});
  const provider = runtime.getProvider("openai-codex");
  if (provider?.id !== "openai-codex" || provider.baseUrl !== "https://chatgpt.com/backend-api" || !provider.auth?.oauth?.isSubscription) return undefined;
  return {
    getProvider: service => service === "openai-codex" ? provider : undefined,
    isUsingOAuth: model => model.provider === "openai-codex",
    getProviderAuth: (service, options) => service === "openai-codex" ? runtime.getAuth(service, options) : undefined
  };
}
async function loadNativeOpenaiQuotaRegistry(signal) {
  if (!nativeQuotaProfile) return undefined;
  const {pathToFileURL} = await import("node:url");
  const {join} = await import("node:path");
  const {AuthStorage} = await import(pathToFileURL(join(nativeQuotaProfile.sdkRoot, "dist/core/auth-storage.js")).href);
  const {ModelRuntime} = await import(pathToFileURL(join(nativeQuotaProfile.sdkRoot, "dist/core/model-runtime.js")).href);
  return createNativeOpenaiQuotaRegistry({AuthStorage, ModelRuntime, agentDir: nativeQuotaProfile.agentDir, join, signal});
}
`;
