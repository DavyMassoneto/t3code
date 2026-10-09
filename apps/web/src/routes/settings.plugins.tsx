import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { PluginsSettingsPanel } from "../components/settings/PluginsSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { resolvePluginsPackageDestination } from "../components/settings/pluginsPackageScope";
import { useProjects } from "../state/entities";

function SettingsPluginsRoute() {
  const target = Route.useSearch();
  const { environment, scope, search } = useSettingsScope();
  const projects = useProjects();
  const destination = resolvePluginsPackageDestination(
    scope,
    environment?.environmentId ?? null,
    projects,
  );
  if (!environment || typeof destination === "string") {
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        {typeof destination === "string"
          ? destination
          : "Connect an environment to manage its plugins."}
      </p>
    );
  }
  return (
    <PluginsSettingsPanel
      key={JSON.stringify([search, destination, environment.environmentId])}
      environmentId={environment.environmentId}
      destination={destination}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
    />
  );
}

export const Route = createFileRoute("/settings/plugins")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsPluginsRoute,
});
