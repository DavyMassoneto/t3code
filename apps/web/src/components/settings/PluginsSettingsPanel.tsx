import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { PiPackagesSettings } from "./PiPackagesSettings";
import type { PluginsPackageDestination } from "./pluginsPackageScope";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface PluginsSettingsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly destination: PluginsPackageDestination;
}

export function PluginsSettingsPanel(props: PluginsSettingsPanelProps) {
  const environment = useEnvironment(props.environmentId);
  let unavailable: string | null = null;
  if (!environment || environment.connection.phase !== "connected") {
    unavailable = environment
      ? `Reconnect ${environment.label} to manage its plugins.`
      : "Reconnect this environment to manage its plugins.";
  } else if (!environment.serverConfig) {
    unavailable = "Loading this environment's configuration…";
  }
  return (
    <SettingsPageContainer>
      <SettingsSection id="plugins" title="Plugins" variant="plain">
        {unavailable || !environment?.serverConfig ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {unavailable}
          </p>
        ) : (
          <EnvironmentPluginsSettings
            key={JSON.stringify([props.environmentId, props.instanceId])}
            {...props}
            settings={environment.serverConfig.settings}
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentPluginsSettings({
  environmentId,
  instanceId,
  destination,
  settings,
}: PluginsSettingsPanelProps & {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(
    instanceId ?? null,
  );
  const instances = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers ?? []), settings),
  ).filter((entry) => entry.driverKind === "pi" && entry.enabled && entry.isAvailable);
  const selected = selectedInstanceId
    ? instances.find((entry) => entry.instanceId === selectedInstanceId)
    : instances[0];

  if (providers === null) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading plugin runtimes…
      </p>
    );
  }
  if (instances.length === 0) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        No enabled Pi runtime is available in this environment. Configure one in Providers to manage
        its plugins.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {instances.length > 1 || !selected ? (
        <div className="flex flex-wrap items-center gap-2 px-4 text-sm">
          <span>Runtime configuration</span>
          <Select
            value={selected?.instanceId ?? ""}
            onValueChange={(value) =>
              setSelectedInstanceId(value ? ProviderInstanceId.make(value) : null)
            }
          >
            <SelectTrigger
              size="sm"
              aria-label="Plugin runtime configuration"
              className="w-auto min-w-48"
            >
              <SelectValue>{selected?.displayName ?? "Select a runtime configuration"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {instances.map((entry) => (
                <SelectItem key={entry.instanceId} value={entry.instanceId}>
                  {entry.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      {!canManage ? (
        <p role="status" className="px-4 text-sm text-muted-foreground">
          Package commands require providers:manage permission on this environment.
        </p>
      ) : null}
      {selected ? (
        <PiPackagesSettings
          key={JSON.stringify([environmentId, selected.instanceId])}
          environmentId={environmentId}
          instanceId={selected.instanceId}
          destination={destination}
        />
      ) : (
        <p role="status" className="px-4 text-sm text-muted-foreground">
          The selected runtime is unavailable or disabled. Choose an enabled Pi configuration above.
        </p>
      )}
    </div>
  );
}
