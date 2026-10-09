import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { isLegacyPiDefaultModel, type ProviderInstanceEntry } from "../../providerInstances";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

export type NativePiService = {
  id: string;
  label: string;
  iconDriverKind: ProviderDriverKind;
};

export type NativePiModelGroup = {
  key: string;
  entry: ProviderInstanceEntry;
  service: NativePiService;
};

export function nativePiModelService(
  model: Pick<ModelEsque, "slug" | "subProvider">,
): NativePiService {
  const separator = model.slug.indexOf("/");
  const id = model.subProvider?.trim() || (separator > 0 ? model.slug.slice(0, separator) : "");
  const normalized = id.toLowerCase();
  if (normalized === "anthropic") {
    return {
      id,
      label: "Anthropic / Claude",
      iconDriverKind: ProviderDriverKind.make("claudeAgent"),
    };
  }
  if (normalized === "openai" || normalized === "openai-codex") {
    return {
      id,
      label: normalized === "openai-codex" ? "OpenAI / Codex" : "OpenAI",
      iconDriverKind: ProviderDriverKind.make("codex"),
    };
  }
  if (normalized === "xai") {
    return { id, label: "xAI / Grok", iconDriverKind: ProviderDriverKind.make("grok") };
  }
  return { id, label: id || "Custom models", iconDriverKind: ProviderDriverKind.make("pi") };
}

export function nativePiModelGroupKey(instanceId: ProviderInstanceId, serviceId: string): string {
  return JSON.stringify([instanceId, serviceId]);
}

export function buildNativePiModelGroups(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  options: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): NativePiModelGroup[] {
  return entries.flatMap((entry) => {
    if (entry.driverKind !== "pi") return [];
    const services = new Map<string, NativePiService>();
    for (const model of options.get(entry.instanceId) ?? []) {
      if (isLegacyPiDefaultModel(model.slug)) continue;
      const service = nativePiModelService(model);
      services.set(service.id, service);
    }
    if (services.size === 0) services.set("", nativePiModelService({ slug: "" }));
    return Array.from(services.values(), (service) => ({
      key: nativePiModelGroupKey(entry.instanceId, service.id),
      entry,
      service,
    }));
  });
}

export function nativePiModelPresentation(entry: ProviderInstanceEntry, model: ModelEsque) {
  const service = nativePiModelService(model);
  return {
    iconDriverKind: entry.driverKind === "pi" ? service.iconDriverKind : entry.driverKind,
    label:
      entry.driverKind === "pi"
        ? `${service.label} · ${entry.displayName} (Pi)`
        : entry.displayName,
    model:
      entry.driverKind === "pi"
        ? {
            ...model,
            name: getDisplayModelName(model),
            shortName: model.shortName
              ? getDisplayModelName(model, { preferShortName: true })
              : undefined,
            subProvider: undefined,
          }
        : model,
  };
}

export function nativePiModelMatchesGroup(
  group: NativePiModelGroup,
  instanceId: ProviderInstanceId,
  model: Pick<ModelEsque, "slug" | "subProvider">,
): boolean {
  return (
    !isLegacyPiDefaultModel(model.slug) &&
    group.entry.instanceId === instanceId &&
    group.service.id === nativePiModelService(model).id
  );
}

export function adjacentNativePiModelGroup(input: {
  groups: ReadonlyArray<NativePiModelGroup>;
  selectedKey: string;
  direction: 1 | -1;
  isSelectable: (entry: ProviderInstanceEntry) => boolean;
}): string {
  const keys = [
    "favorites",
    ...input.groups.filter((group) => input.isSelectable(group.entry)).map((group) => group.key),
  ];
  const index = keys.indexOf(input.selectedKey);
  return keys[
    index < 0
      ? input.direction === 1
        ? 0
        : keys.length - 1
      : (index + input.direction + keys.length) % keys.length
  ]!;
}
