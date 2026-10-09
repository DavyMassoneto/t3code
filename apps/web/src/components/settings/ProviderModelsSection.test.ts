import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { groupModelsForDisplay, nextHiddenModelsForBulkToggle } from "./ProviderModelsSection";

function model(slug: string, isCustom = false): ServerProviderModel {
  return { slug, name: slug, isCustom, capabilities: null };
}

describe("groupModelsForDisplay", () => {
  it("groups hidden Pi custom favorites with hidden models while preserving visible service order", () => {
    const models = [
      model("anthropic/custom", true),
      model("openai/custom", true),
      model("anthropic/native"),
      model("anthropic/second", true),
    ];
    expect(
      groupModelsForDisplay(models, {
        favoriteModels: new Set(["anthropic/custom", "openai/custom"]),
        hiddenModels: new Set(["anthropic/custom"]),
        modelOrder: ["anthropic/custom", "anthropic/second", "anthropic/native"],
        hideCustomModels: true,
      }).map((entry) => entry.slug),
    ).toEqual(["openai/custom", "anthropic/second", "anthropic/native", "anthropic/custom"]);
  });
  it("lists favorites first, then visible models in user order, then hidden ones", () => {
    const models = [model("a"), model("b"), model("c"), model("d"), model("custom", true)];

    const display = groupModelsForDisplay(models, {
      favoriteModels: new Set(["c"]),
      hiddenModels: new Set(["a", "custom"]),
      modelOrder: ["d", "b"],
    });

    // A custom model is never hidden, even if its slug is in the hidden set.
    expect(display.map((entry) => entry.slug)).toEqual(["c", "d", "b", "custom", "a"]);
  });
});

describe("nextHiddenModelsForBulkToggle", () => {
  it("hides and restores Pi native custom models without changing another service's hidden models", () => {
    const models = [model("anthropic/native"), model("anthropic/custom", true)];
    const hidden = nextHiddenModelsForBulkToggle(models, ["openai/custom"], {
      hideCustomModels: true,
    });
    expect(hidden).toEqual(["openai/custom", "anthropic/native", "anthropic/custom"]);
    expect(nextHiddenModelsForBulkToggle(models, hidden, { hideCustomModels: true })).toEqual([
      "openai/custom",
    ]);
  });
  it("hides every built-in model without hiding custom models", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a"])).toEqual(["a", "b"]);
  });

  it("shows every built-in model while preserving unrelated hidden entries", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a", "b", "legacy", "custom"])).toEqual([
      "legacy",
      "custom",
    ]);
  });
});
