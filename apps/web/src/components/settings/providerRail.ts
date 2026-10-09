import type { EnvironmentId, PiConnection, ProviderInstanceId } from "@t3tools/contracts";

export function buildNativeProviderRail(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  connections: readonly PiConnection[],
  configuringService: string | null = null,
) {
  return connections
    .filter((connection) => connection.configured || connection.service === configuringService)
    .map((connection) => ({
      environmentId,
      instanceId,
      service: connection.service,
      connection,
    }));
}

export function filterNativeProviderCatalog(connections: readonly PiConnection[], query: string) {
  const normalized = query.trim().toLowerCase();
  return connections.filter(
    (connection) =>
      !connection.configured &&
      `${connection.name} ${connection.service}`.toLowerCase().includes(normalized),
  );
}

export function nativeServiceOwnsModel(service: string, slug: string) {
  return slug.startsWith(`${service}/`);
}

export function mergeNativeServiceValues(
  existing: readonly string[],
  next: readonly string[],
  service: string,
  modelSlugs: readonly string[] = [],
) {
  const belongs = (slug: string) =>
    nativeServiceOwnsModel(service, slug) || modelSlugs.includes(slug);
  return [...new Set([...existing.filter((slug) => !belongs(slug)), ...next.filter(belongs)])];
}

export function resolveNativeProviderSelection(
  entries: ReturnType<typeof buildNativeProviderRail>,
  service: string | null,
) {
  return entries.find((entry) => entry.service === service) ?? entries[0] ?? null;
}
