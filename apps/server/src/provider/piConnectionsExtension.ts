import { PI_PROVIDER_LIMITS_NATIVE_SOURCE } from "./piProviderLimitsNative.ts";
import { PI_OPENAI_QUOTA_REGISTRY_NATIVE_SOURCE } from "./piOpenaiQuotaRegistryNative.ts";

export const PI_CONNECTIONS_COMMAND = "t3-native-connections";

const discoverySource = String.raw`
export default function(pi) {
  pi.on("session_start", async (_event, ctx) => {
    const registry = ctx.modelRegistry;
    if (typeof registry.getProviderAuthStatus !== "function" || typeof registry.getProvider !== "function") return;
    const available = new Set(registry.getAvailable().map(model => model.provider + "/" + model.id));
    const groups = new Map();
    for (const model of registry.getAll()) {
      let group = groups.get(model.provider);
      if (!group) {
        const provider = registry.getProvider(model.provider);
        const status = registry.getProviderAuthStatus(model.provider);
        const sources = ["stored", "runtime", "environment", "fallback", "models_json_key", "models_json_command"];
        group = {
          service: model.provider,
          name: provider?.name || model.provider,
          configured: status.configured === true,
          ...(sources.includes(status.source) ? {authSource: status.source} : {}),
          authMethods: [...(provider?.auth?.apiKey ? ["api_key"] : []), ...(provider?.auth?.oauth ? ["oauth"] : [])],
          authentication: "managed-in-pi",
          limits: "unavailable",
          models: []
        };
        groups.set(model.provider, group);
      }
      const slug = model.provider + "/" + model.id;
      group.models.push({slug, name: model.name || model.id, available: available.has(slug)});
    }
    if (includeLimits) await collectProviderLimits(pi, registry, groups, registry.getAll());
    if (diagnosticOutputOnly) {
      const group = groups.get("openai");
      const details = group?.limitsDetails;
      const diagnostic = limitsProbeDiagnostics.get("openai");
      pi.registerCommand("t3-openai-limits-diagnostic", {
        description: JSON.stringify({status: details?.status || "unsupported", authType: diagnostic?.authType || "unknown", ...(diagnostic?.httpStatus ? {httpStatus: diagnostic.httpStatus} : {}), metricCount: details?.metrics.length || 0}),
        handler: async () => {}
      });
      return;
    }
    pi.registerCommand("t3-native-connections", {
      description: JSON.stringify(Array.from(groups.values())),
      handler: async () => {}
    });
  });
}
`;

export const makePiConnectionsExtensionSource = (
  includeLimits: boolean,
  options: {
    readonly openaiDiagnostic?: boolean;
    readonly directTokenProbe?: boolean;
    readonly diagnosticOutputOnly?: boolean;
    readonly nativeQuotaProfile?: { readonly sdkRoot: string; readonly agentDir: string };
  } = {},
) =>
  `const includeLimits = ${includeLimits};\nconst openaiDiagnostics = ${options.openaiDiagnostic === true};\nconst directTokenProbe = ${options.openaiDiagnostic === true && options.directTokenProbe === true};\nconst diagnosticOutputOnly = ${options.diagnosticOutputOnly === true};\nconst nativeQuotaProfile = ${JSON.stringify(options.nativeQuotaProfile ?? null)};\n${includeLimits ? PI_OPENAI_QUOTA_REGISTRY_NATIVE_SOURCE + PI_PROVIDER_LIMITS_NATIVE_SOURCE : ""}\n${discoverySource}`;

export const PI_CONNECTIONS_EXTENSION_SOURCE = makePiConnectionsExtensionSource(false);
