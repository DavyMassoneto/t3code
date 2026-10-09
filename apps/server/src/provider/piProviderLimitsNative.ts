export const PI_PROVIDER_LIMITS_NATIVE_SOURCE = String.raw`
const limitReaders = new Map();
const limitsProbeDiagnostics = new Map();
let nativeOpenaiQuotaRegistry;
const finite = value => typeof value === "number" && Number.isFinite(value);
const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) === value.slice(0, 10) ? new Date(value).toISOString() : undefined;
const endpointMatches = (value, expected) => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.href.replace(/\/$/, "") === expected;
  } catch { return false; }
};
const loopbackEndpoint = value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password; } catch { return false; }
};
const result = (status, source, metrics = [], message) => ({status, source, checkedAt: new Date().toISOString(), metrics, ...(message ? {message} : {})});
const percentWindow = (id, label, window, usedField, seconds) => {
  if (!window || !finite(window[usedField])) return [];
  const used = window[usedField];
  const reset = usedField === "utilization" ? timestamp(window.resets_at) : finite(window.reset_at) && Math.abs(window.reset_at) < 8640000000000 ? new Date(window.reset_at * 1000).toISOString() : undefined;
  const duration = finite(window.limit_window_seconds) && window.limit_window_seconds > 0 ? window.limit_window_seconds : seconds;
  return [{id, label, unit: "percent", used, limit: 100, ...(duration ? {windowSeconds: duration} : {}), ...(reset ? {resetsAt: reset} : {})}];
};
const readVenice = body => {
  const data = body?.data;
  if (!data || typeof data !== "object") throw new Error("invalid response");
  const metrics = [];
  for (const [currency, label, unit] of [["USD", "USD balance", "USD"], ["DIEM", "Diem balance", "DIEM"], ["BUNDLED_CREDITS", "Bundled credit balance", "USD"]]) {
    if (finite(data.balances?.[currency])) metrics.push({id: "balance-" + currency.toLowerCase(), label, unit, remaining: data.balances[currency]});
  }
  return metrics;
};
const readCodex = body => {
  const metrics = [
    ...percentWindow("primary", "Primary subscription window", body?.rate_limit?.primary_window, "used_percent"),
    ...percentWindow("secondary", "Secondary subscription window", body?.rate_limit?.secondary_window, "used_percent")
  ];
  const balance = body?.credits?.balance;
  if ((finite(balance) || typeof balance === "string" && /^\d+(\.\d+)?$/.test(balance)) && Number.isFinite(Number(balance))) metrics.push({id: "balance", label: "Credit balance", unit: "credits", remaining: Number(balance)});
  return metrics;
};
const readAnthropic = body => {
  const metrics = [];
  for (const [id, label, seconds] of [["five_hour", "Five-hour subscription window", 18000], ["seven_day", "Weekly subscription window", 604800], ["seven_day_opus", "Weekly Opus window", 604800], ["seven_day_sonnet", "Weekly Sonnet window", 604800]]) metrics.push(...percentWindow(id, label, body?.[id], "utilization", seconds));
  return metrics;
};
const safeExtensionMetrics = data => {
  if (!Array.isArray(data?.metrics)) return [];
  return data.metrics.slice(0, 100).flatMap((metric, index) => {
    if (!metric || !["percent", "USD", "DIEM", "credits", "requests", "tokens"].includes(metric.unit)) return [];
    const values = Object.fromEntries(["used", "limit", "remaining", "windowSeconds"].filter(key => finite(metric[key]) && (key !== "windowSeconds" || metric[key] >= 0)).map(key => [key, metric[key]]));
    if (!["used", "limit", "remaining"].some(key => key in values)) return [];
    const reset = timestamp(metric.resetsAt);
    return [{id: "extension-" + (index + 1), label: "Extension metric " + (index + 1), unit: metric.unit, ...values, ...(reset ? {resetsAt: reset} : {})}];
  });
};
async function queryProviderLimits(registry, service, models, signal) {
  const diagnosticKey = openaiDiagnostics && ["openai", "openai-codex"].includes(service) ? "openai" : undefined;
  if (diagnosticKey) limitsProbeDiagnostics.set(diagnosticKey, {authType: "unknown"});
  const provider = registry.getProvider(service);
  const model = models[0];
  if (["ollama", "llamacpp", "llamacpp-local", "llama.cpp", "llama-cpp"].includes(service) && models.length && models.every(candidate => loopbackEndpoint(candidate.baseUrl)) && (!provider?.baseUrl || loopbackEndpoint(provider.baseUrl))) return result("not_applicable", "native-local-runtime", [], "Local inference has no provider account quota.");
  const extension = limitReaders.get(service);
  if (extension) {
    try {
      const metrics = safeExtensionMetrics(await extension({signal}));
      return metrics.length ? result("available", "pi-extension", metrics) : result("unsupported", "pi-extension", [], "The extension returned no supported metrics.");
    } catch { return result("error", "pi-extension", [], "The extension could not read provider limits."); }
  }
  if (service === "openai" && nativeOpenaiQuotaRegistry && !directTokenProbe) {
    const quota = await queryProviderLimits(nativeOpenaiQuotaRegistry, "openai-codex", [{provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api"}], signal);
    const note = "OpenAI subscription quota from the separately authorized native Pi openai-codex login. Direct OpenAI inference authentication is unchanged; account identity is not automatically linked.";
    return {...quota, source: "native-openai-separate-quota-oauth", message: [quota.message, note].filter(Boolean).join(" ")};
  }
  let source, endpoint, base, parse, oauth = false;
  if (service === "venice") {
    source = "venice-api"; base = "https://api.venice.ai/api/v1"; endpoint = base + "/api_keys/rate_limits"; parse = readVenice;
  } else if (service === "openai-codex") {
    source = "openai-codex-private-api"; base = "https://chatgpt.com/backend-api"; endpoint = base + "/wham/usage"; parse = readCodex; oauth = true;
  } else if (service === "openai") {
    source = "openai-private-oauth-api"; base = "https://api.openai.com/v1"; endpoint = "https://chatgpt.com/backend-api/wham/usage"; parse = readCodex; oauth = true;
    if (!directTokenProbe) return result("unsupported", "native-openai-direct-auth", [], "This connection's native OpenAI direct token cannot read subscription quota through this integration. The approved quota probe returned HTTP 401. Authorize native Pi subscription quota sign-in or install an explicit limits extension; inference authentication is unchanged.");
  } else if (service === "anthropic") {
    source = "anthropic-private-oauth-api"; base = "https://api.anthropic.com"; endpoint = base + "/api/oauth/usage"; parse = readAnthropic; oauth = true;
  } else return result("unsupported", "native-registry", [], "This native provider has no supported limits capability.");
  if (!model || !endpointMatches(model.baseUrl, base) || provider?.baseUrl && !endpointMatches(provider.baseUrl, base)) return result("unsupported", source, [], "Custom provider endpoints are not eligible for built-in account probes.");
  const nativeOAuth = typeof registry.isUsingOAuth === "function" ? registry.isUsingOAuth(model) : undefined;
  if (diagnosticKey) limitsProbeDiagnostics.set(diagnosticKey, {authType: nativeOAuth === true ? "oauth" : nativeOAuth === false && registry.getProviderAuthStatus(service)?.configured === true ? "api_key" : "unknown"});
  if (nativeOAuth !== oauth) return result("unsupported", source, [], oauth ? "Subscription limits require native OAuth authentication." : "This limits API requires native API-key authentication.");
  try {
    signal.throwIfAborted();
    let auth;
    if (service === "openai" || service === "openai-codex" && typeof registry.getProviderAuth === "function") {
      if (typeof registry.getProviderAuth !== "function") return result("unsupported", source, [], "Native provider-scoped OAuth resolution is unavailable.");
      const resolution = await registry.getProviderAuth(service, {signal});
      auth = resolution?.auth ? {ok: true, ...resolution.auth} : undefined;
    } else auth = await registry.getApiKeyAndHeaders(model);
    signal.throwIfAborted();
    if (!auth?.ok || auth.baseUrl && !endpointMatches(auth.baseUrl, base)) return result("unsupported", source, [], "Native request authentication is not eligible for this limits API.");
    const supplied = new Headers(auth.headers || {});
    const bearer = supplied.get("authorization");
    const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : auth.apiKey;
    if (typeof token !== "string" || !token) return result("unsupported", source, [], "Native request authentication has no supported credential.");
    const headers = {authorization: "Bearer " + token, accept: "application/json"};
    if (service === "anthropic") headers["anthropic-beta"] = "oauth-2025-04-20";
    if (service === "openai-codex" || service === "openai") {
      let payload;
      try { payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch {}
      if (service === "openai" && payload && (payload.iss !== "https://auth.openai.com" || !["https://api.openai.com/v1", "https://api.openai.com"].includes(payload.aud))) return result("unsupported", source, [], "The native OAuth token is not issued for the official OpenAI API.");
      const account = supplied.get("chatgpt-account-id") ?? payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (account !== undefined && account !== null && (typeof account !== "string" || !account || account.length > 200 || /[\r\n]/.test(account))) return result("unsupported", source, [], "Native OAuth account routing metadata is invalid.");
      if (service === "openai-codex" && !account) return result("unsupported", source, [], "Native OAuth credentials lack Codex account routing metadata.");
      if (account) headers["ChatGPT-Account-Id"] = account;
    }
    const response = await fetch(endpoint, {method: "GET", headers, signal, redirect: "error"});
    if (diagnosticKey && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) limitsProbeDiagnostics.set(diagnosticKey, {...limitsProbeDiagnostics.get(diagnosticKey), httpStatus: response.status});
    if (!response.ok) return result("error", source, [], "The provider limits request failed (HTTP " + response.status + ").");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response");
    const decoder = new TextDecoder();
    let text = "", bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1000000) { await reader.cancel(); throw new Error("response too large"); }
        text += decoder.decode(chunk.value, {stream: true});
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const metrics = parse(JSON.parse(text));
    return metrics.length ? result("available", source, metrics) : result("unsupported", source, [], "The provider returned no supported quota or balance metrics.");
  } catch { return result("error", source, [], "The provider limits request could not be completed."); }
}
async function collectProviderLimits(pi, registry, groups, models) {
  try { if (!openaiDiagnostics) pi.events?.emit("t3:provider-limits:collect", {version: 1, register(service, reader) {
    if (typeof service === "string" && groups.has(service) && typeof reader === "function" && !limitReaders.has(service)) limitReaders.set(service, reader);
  }}); } catch {}
  const deadline = AbortSignal.timeout(12000);
  const directModels = models.filter(model => model.provider === "openai");
  let eligibleDirect = false;
  try {
    const provider = registry.getProvider("openai");
    eligibleDirect = groups.has("openai") && directModels.length && directModels.every(model => endpointMatches(model.baseUrl, "https://api.openai.com/v1")) && (!provider?.baseUrl || endpointMatches(provider.baseUrl, "https://api.openai.com/v1"));
  } catch {}
  if (!directTokenProbe && eligibleDirect && !limitReaders.has("openai")) {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(5000)]);
    let cancel;
    const cancelled = new Promise(resolve => {cancel = () => resolve(undefined); if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, {once: true});});
    try {
      nativeOpenaiQuotaRegistry = await Promise.race([loadNativeOpenaiQuotaRegistry(signal), cancelled]);
      if (!nativeOpenaiQuotaRegistry) {
        const legacy = registry.getProvider("openai-codex");
        const status = registry.getProviderAuthStatus("openai-codex");
        if (legacy?.baseUrl === "https://chatgpt.com/backend-api" && legacy.auth?.oauth && status?.configured === true && typeof registry.getProviderAuth === "function" && typeof registry.isUsingOAuth === "function" && registry.isUsingOAuth({provider: "openai-codex"}) === true) {
          nativeOpenaiQuotaRegistry = {getProvider: () => legacy, isUsingOAuth: () => true, getProviderAuth: (service, options) => registry.getProviderAuth(service, options)};
        }
      }
      if (nativeOpenaiQuotaRegistry) groups.delete("openai-codex");
    } catch {} finally {signal.removeEventListener("abort", cancel);}
  }
  const pending = Array.from(groups.values()).filter(group => !openaiDiagnostics || group.service === "openai");
  async function worker() {
    for (;;) {
      const group = pending.shift();
      if (!group) return;
      if (deadline.aborted) {
        group.limitsDetails = result("error", "native-limits", [], "The provider limits request timed out.");
        group.limits = "error";
        continue;
      }
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(5000)]);
      let timeout;
      const cancelled = new Promise(resolve => {
        timeout = () => resolve(result("error", "native-limits", [], "The provider limits request timed out."));
        if (signal.aborted) timeout(); else signal.addEventListener("abort", timeout, {once: true});
      });
      group.limitsDetails = await Promise.race([queryProviderLimits(registry, group.service, models.filter(model => model.provider === group.service), signal), cancelled]).catch(() => result("error", "native-limits", [], "The provider limits capability failed."));
      signal.removeEventListener("abort", timeout);
      group.limits = group.limitsDetails.status;
    }
  }
  await Promise.all(Array.from({length: Math.min(3, pending.length)}, worker));
}
`;
