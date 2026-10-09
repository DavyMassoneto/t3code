import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: () => {},
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useMemo: reactHookHarness.useMemo,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { ProviderModelsSection } from "./ProviderModelsSection";

const onHiddenModelsChange = vi.fn();
const onFavoriteModelsChange = vi.fn();
const onModelOrderChange = vi.fn();
const customSlug = "anthropic/custom";
function renderSection({
  driverKind = ProviderDriverKind.make("pi"),
  hiddenModels = [] as string[],
  customOnly = false,
  canWritePreferences = true,
  favoriteModels = [] as string[],
} = {}) {
  hooks.beginRender();
  return ProviderModelsSection({
    instanceId: ProviderInstanceId.make("work"),
    driverKind,
    models: [
      ...(customOnly
        ? []
        : [{ slug: "anthropic/native", name: "Native", isCustom: false, capabilities: null }]),
      { slug: customSlug, name: "Custom", isCustom: true, capabilities: null },
    ],
    customModels: [{ slug: customSlug, name: "Custom" }],
    canManageCustomModels: true,
    canWritePreferences,
    hiddenModels,
    favoriteModels,
    modelOrder: [],
    onChange: () => {},
    onHiddenModelsChange,
    onFavoriteModelsChange,
    onModelOrderChange,
  });
}

describe("Pi custom model visibility controls", () => {
  beforeEach(() => {
    hooks.reset();
    onHiddenModelsChange.mockReset();
    onFavoriteModelsChange.mockReset();
    onModelOrderChange.mockReset();
  });
  it("enables the custom model's picker switch for Pi and restores an individually hidden model", () => {
    const panel = renderSection({ hiddenModels: [customSlug, "openai/custom"] });
    const toggle = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Show Custom in the model picker",
    );
    if (!toggle) throw new Error("Missing custom model visibility switch");
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props.checked).toBe(false);
    (toggle.props.onCheckedChange as (checked: boolean) => void)(true);
    expect(onHiddenModelsChange).toHaveBeenCalledExactlyOnceWith(["openai/custom"]);
  });
  it("disables an individually visible Pi custom model without changing other service filters", () => {
    const panel = renderSection({ hiddenModels: ["openai/custom"] });
    const toggle = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Show Custom in the model picker",
    );
    if (!toggle) throw new Error("Missing custom model switch");
    (toggle.props.onCheckedChange as (checked: boolean) => void)(false);
    expect(onHiddenModelsChange).toHaveBeenCalledExactlyOnceWith(["openai/custom", customSlug]);
  });
  it("supports bulk disable and enable when a Pi service has only custom models", () => {
    let panel = renderSection({ customOnly: true, hiddenModels: ["openai/custom"] });
    const disable = visitElements(panel, (element) => element.props.children === "Disable all");
    if (!disable) throw new Error("Missing custom-only bulk visibility action");
    (disable.props.onClick as () => void)();
    expect(onHiddenModelsChange).toHaveBeenLastCalledWith(["openai/custom", customSlug]);
    panel = renderSection({ customOnly: true, hiddenModels: ["openai/custom", customSlug] });
    const enable = visitElements(panel, (element) => element.props.children === "Enable all");
    if (!enable) throw new Error("Missing bulk enable action");
    (enable.props.onClick as () => void)();
    expect(onHiddenModelsChange).toHaveBeenLastCalledWith(["openai/custom"]);
  });
  it("places hidden Pi custom favorites in the hidden group without changing favorite metadata", () => {
    const panel = renderSection({ hiddenModels: [customSlug], favoriteModels: [customSlug] });
    expect(
      visitElements(panel, (element) => element.props.children === "Hidden from picker"),
    ).not.toBeNull();
    expect(visitElements(panel, (element) => element.props.children === "Favorites")).toBeNull();
    const row = visitElements(panel, (element) => element.props["data-model-slug"] === customSlug);
    expect(row?.props.className).toContain("opacity-50");
    expect(
      visitElements(row, (element) => element.props["aria-label"] === "Move Custom up"),
    ).toBeNull();
    expect(onFavoriteModelsChange).not.toHaveBeenCalled();
    expect(onModelOrderChange).not.toHaveBeenCalled();
  });
  it("keeps non-Pi custom models visible and their switch disabled", () => {
    const panel = renderSection({
      driverKind: ProviderDriverKind.make("claudeAgent"),
      hiddenModels: [customSlug],
    });
    const toggle = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Show Custom in the model picker",
    );
    expect(toggle?.props.disabled).toBe(true);
    expect(toggle?.props.checked).toBe(true);
    expect(
      visitElements(panel, (element) => element.props.children === "Hidden from picker"),
    ).toBeNull();
  });
  it("guards individual and bulk visibility changes without preference write permission", () => {
    const panel = renderSection({ canWritePreferences: false });
    const toggle = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Show Custom in the model picker",
    );
    const bulk = visitElements(panel, (element) => element.props.children === "Disable all");
    if (!toggle || !bulk) throw new Error("Missing guarded model controls");
    expect(toggle.props.disabled).toBe(true);
    expect(bulk.props.disabled).toBe(true);
    (toggle.props.onCheckedChange as (checked: boolean) => void)(false);
    (bulk.props.onClick as () => void)();
    expect(onHiddenModelsChange).not.toHaveBeenCalled();
  });
});
