export const PI_OPENAI_QUOTA_AUTH_OPERATION_SOURCE = String.raw`
async function runOpenaiQuotaAuth({input, AuthStorage, ModelRuntime, join, signal, emit}) {
  signal.throwIfAborted();
  if (input.consent !== true || !["login", "logout"].includes(input.action)) throw new Error("Invalid consent");
  const store = AuthStorage.create(join(input.agentDir, "auth.json"));
  if (input.action === "logout") {
    await store.delete("openai-codex", {signal});
    signal.throwIfAborted();
    emit({type: "complete", configured: false});
    return;
  }
  const pending = AuthStorage.inMemory();
  const runtime = await ModelRuntime.create({credentials: pending, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal});
  const provider = runtime.getProvider("openai-codex");
  if (provider?.id !== "openai-codex" || provider.baseUrl !== "https://chatgpt.com/backend-api" || !provider.auth?.oauth?.isSubscription) throw new Error("Unsupported native quota provider");
  let notified = false;
  const credential = await runtime.login("openai-codex", "oauth", {
    signal,
    async prompt(prompt) {
      signal.throwIfAborted();
      if (prompt.type !== "select" || !prompt.options?.some(option => option.id === "device_code")) throw new Error("Unsupported native login interaction");
      return "device_code";
    },
    notify(event) {
      signal.throwIfAborted();
      if (event.type !== "device_code") return;
      if (notified || event.verificationUri !== "https://auth.openai.com/codex/device" || typeof event.userCode !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(event.userCode)) throw new Error("Invalid native login event");
      notified = true;
      emit({type: "device_code", url: event.verificationUri, userCode: event.userCode});
    }
  }, {agentName: "Pi"});
  signal.throwIfAborted();
  if (!notified || credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access || typeof credential.refresh !== "string" || !credential.refresh || !Number.isFinite(credential.expires) || credential.expires <= Date.now() || typeof credential.accountId !== "string" || !credential.accountId || credential.accountId.length > 200 || /[\r\n]/.test(credential.accountId)) throw new Error("Invalid native quota credential");
  await store.modify("openai-codex", () => {signal.throwIfAborted(); return credential;}, {signal});
  signal.throwIfAborted();
  emit({type: "complete", configured: true});
}
`;

export const PI_OPENAI_QUOTA_AUTH_NATIVE_SOURCE = String.raw`
${PI_OPENAI_QUOTA_AUTH_OPERATION_SOURCE}
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
try {
  const {pathToFileURL} = await import("node:url");
  const {join, isAbsolute} = await import("node:path");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error("Invalid input");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  chunks.length = 0;
  if (typeof input.agentDir !== "string" || !isAbsolute(input.agentDir) || typeof input.sdkRoot !== "string" || !isAbsolute(input.sdkRoot)) throw new Error("Invalid input");
  process.env.PI_OFFLINE = "1";
  const {AuthStorage} = await import(pathToFileURL(join(input.sdkRoot, "dist/core/auth-storage.js")).href);
  const {ModelRuntime} = await import(pathToFileURL(join(input.sdkRoot, "dist/core/model-runtime.js")).href);
  await runOpenaiQuotaAuth({input, AuthStorage, ModelRuntime, join, signal, emit});
} catch {
  emit({type: "error"});
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
}
`;
