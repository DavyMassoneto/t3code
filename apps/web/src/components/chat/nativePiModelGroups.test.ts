import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { providerModelKey } from "../../modelOrdering";
import {
  adjacentNativePiModelGroup,
  buildNativePiModelGroups,
  nativePiModelGroupKey,
  nativePiModelMatchesGroup,
  nativePiModelPresentation,
  nativePiModelService,
} from "./nativePiModelGroups";
import { scoreModelPickerSearch } from "./modelPickerSearch";
import type { ModelEsque } from "./providerIconUtils";

function piEntry(instanceId: string, status: ServerProvider["status"] = "ready") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("pi"),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-10-08T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

const models: ReadonlyArray<ModelEsque> = [
  { slug: "default", name: "Default", isDefault: true },
  {
    slug: "anthropic/claude-sonnet",
    name: "anthropic: Claude Sonnet",
    subProvider: "anthropic",
    isDefault: true,
  },
  { slug: "openai-codex/gpt", name: "GPT", subProvider: "openai-codex" },
  { slug: "xai/grok", name: "Grok", subProvider: "xai" },
  { slug: "company/custom", name: "Company model", subProvider: "company" },
  { slug: "bare-custom", name: "Custom model" },
];

describe("native Pi model groups", () => {
  it("groups native services without inventing instances or changing options", () => {
    const entry = piEntry("pi_work");
    const groups = buildNativePiModelGroups([entry], new Map([[entry.instanceId, models]]));
    expect(groups.map((group) => group.service.label)).toEqual([
      "Anthropic / Claude",
      "OpenAI / Codex",
      "xAI / Grok",
      "company",
      "Custom models",
    ]);
    for (const group of groups) {
      expect(group.entry).toBe(entry);
      const matching = models.filter((model) =>
        nativePiModelMatchesGroup(group, entry.instanceId, model),
      );
      expect(matching).toHaveLength(1);
      expect(resolveSelectableModel(group.entry.driverKind, matching[0]!.slug, models)).toBe(
        matching[0]!.slug,
      );
    }
    expect(models[0]).toEqual({ slug: "default", name: "Default", isDefault: true });
  });

  it("does not create a default service for either legacy marker", () => {
    const entry = piEntry("pi");
    const groups = buildNativePiModelGroups(
      [entry],
      new Map([
        [
          entry.instanceId,
          [...models, { slug: "pi-default", name: "Pi default", isDefault: true }],
        ],
      ]),
    );
    expect(
      groups.some((group) => group.service.id === "default" || group.service.id === "pi-default"),
    ).toBe(false);
    expect(groups).toHaveLength(5);
  });

  it("keeps identical services and favorites scoped to their true Pi instances", () => {
    const personal = piEntry("pi_personal");
    const work = piEntry("pi_work");
    const model = models[1]!;
    const groups = buildNativePiModelGroups(
      [personal, work],
      new Map([
        [personal.instanceId, [model]],
        [work.instanceId, [model]],
      ]),
    );
    expect(groups[0]!.key).not.toBe(groups[1]!.key);
    expect(nativePiModelMatchesGroup(groups[0]!, work.instanceId, model)).toBe(false);
    const favorites = new Set([providerModelKey(work.instanceId, model.slug)]);
    expect(favorites.has(providerModelKey(groups[0]!.entry.instanceId, model.slug))).toBe(false);
    expect(favorites.has(providerModelKey(groups[1]!.entry.instanceId, model.slug))).toBe(true);
  });

  it("uses subProvider before the slug prefix, and recognizes prefix-only unavailable models", () => {
    expect(nativePiModelService({ slug: "proxy/model", subProvider: "anthropic" }).id).toBe(
      "anthropic",
    );
    expect(nativePiModelService({ slug: "xai/missing" }).label).toBe("xAI / Grok");
    expect(nativePiModelService({ slug: "openai/gpt" }).label).toBe("OpenAI");
    expect(nativePiModelService({ slug: "other-provider/model" }).label).toBe("other-provider");
  });

  it("keeps default, custom, legacy and unavailable metadata through presentation", () => {
    const entry = piEntry("pi");
    for (const model of [
      ...models,
      { ...models[1]!, isUnavailable: true, isLegacy: true, aliases: ["old"] },
    ]) {
      const presentation = nativePiModelPresentation(entry, model);
      expect(presentation.model.slug).toBe(model.slug);
      expect(presentation.model.isDefault).toBe(model.isDefault);
      expect(presentation.model.isUnavailable).toBe(model.isUnavailable);
      expect(presentation.model.isLegacy).toBe(model.isLegacy);
      expect(presentation.model.aliases).toBe(model.aliases);
      expect(presentation.label).toContain("Pi");
    }
    expect(nativePiModelPresentation(entry, models[1]!).model.name).toBe("Claude Sonnet");
    expect(nativePiModelPresentation(entry, models[1]!).iconDriverKind).toBe("claudeAgent");
    expect(nativePiModelPresentation(entry, models[2]!).iconDriverKind).toBe("codex");
    expect(nativePiModelPresentation(entry, models[3]!).iconDriverKind).toBe("grok");
    expect(entry.driverKind).toBe("pi");
  });

  it("searches service aliases while still identifying the Pi harness and custom account", () => {
    const entry = { ...piEntry("pi_work"), displayName: "Work account" };
    const model = { slug: "anthropic/model", name: "Sonnet", subProvider: "anthropic" };
    const input = {
      name: model.name,
      subProvider: model.subProvider,
      driverKind: entry.driverKind,
      providerDisplayName: `${nativePiModelService(model).label} ${entry.displayName}`,
    };
    for (const query of ["Claude", "Anthropic", "Pi", "work sonnet"]) {
      expect(scoreModelPickerSearch(input, query)).not.toBeNull();
    }
  });

  it("cycles through services and favorites, applying readiness and thread locks to real instances", () => {
    const work = piEntry("pi_work");
    const locked = piEntry("pi_locked");
    const unavailable = piEntry("pi_offline", "error");
    const groups = buildNativePiModelGroups(
      [work, locked, unavailable],
      new Map([
        [work.instanceId, models.slice(1, 3)],
        [locked.instanceId, [models[3]!]],
        [unavailable.instanceId, [{ slug: "xai/missing", name: "Missing", isUnavailable: true }]],
      ]),
    );
    const base = {
      groups,
      isSelectable: (entry: typeof work) =>
        entry.instanceId !== locked.instanceId && isProviderInstancePickerReady(entry),
    };
    expect(adjacentNativePiModelGroup({ ...base, selectedKey: groups[0]!.key, direction: 1 })).toBe(
      groups[1]!.key,
    );
    expect(adjacentNativePiModelGroup({ ...base, selectedKey: groups[1]!.key, direction: 1 })).toBe(
      "favorites",
    );
    expect(adjacentNativePiModelGroup({ ...base, selectedKey: "favorites", direction: -1 })).toBe(
      groups[1]!.key,
    );
    expect(
      adjacentNativePiModelGroup({
        ...base,
        selectedKey: groups[1]!.key,
        direction: 1,
        isSelectable: (entry) =>
          base.isSelectable(entry) || entry.instanceId === unavailable.instanceId,
      }),
    ).toBe(groups[3]!.key);
  });

  it("keeps setup reachable for empty instances and handles missing selections", () => {
    const entry = piEntry("pi_empty", "error");
    const groups = buildNativePiModelGroups([entry], new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entry).toBe(entry);
    expect(groups[0]!.key).toBe(nativePiModelGroupKey(entry.instanceId, ""));
    expect(
      adjacentNativePiModelGroup({
        groups,
        selectedKey: "removed",
        direction: -1,
        isSelectable: () => true,
      }),
    ).toBe(groups[0]!.key);
    expect(
      adjacentNativePiModelGroup({
        groups: [],
        selectedKey: "removed",
        direction: 1,
        isSelectable: () => true,
      }),
    ).toBe("favorites");
  });
});
