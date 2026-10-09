import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderModelCapabilities } from "./providerModels";

const PROVIDER = ProviderDriverKind.make("claudeAgent");

function capabilities(id: string): ModelCapabilities {
  return {
    optionDescriptors: [{ id, label: id, type: "boolean" }],
  };
}

function model(input: {
  slug: string;
  capabilities: ModelCapabilities;
  aliases?: ReadonlyArray<string>;
  isCustom?: boolean;
  isDefault?: boolean;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    ...(input.aliases ? { aliases: [...input.aliases] } : {}),
    isCustom: input.isCustom ?? false,
    ...(input.isDefault ? { isDefault: true } : {}),
    capabilities: input.capabilities,
  };
}

describe("getProviderModelCapabilities", () => {
  it.each(["default", "pi-default"])(
    "uses native default capabilities for legacy Pi selection %s",
    (marker) => {
      const nativeCapabilities = capabilities("native-thinking");
      const models = [
        model({ slug: "default", isDefault: true, capabilities: capabilities("ghost") }),
        model({ slug: "openai/first", capabilities: capabilities("first") }),
        model({
          slug: "plugin/native",
          isDefault: true,
          isCustom: true,
          capabilities: nativeCapabilities,
        }),
      ];
      expect(getProviderModelCapabilities(models, marker, ProviderDriverKind.make("pi"))).toEqual(
        nativeCapabilities,
      );
      expect(
        getProviderModelCapabilities(models.slice(0, 2), marker, ProviderDriverKind.make("pi")),
      ).not.toEqual(models[0]!.capabilities);
    },
  );
  it("resolves model-declared aliases", () => {
    const aliasCapabilities = capabilities("aliased-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["Legacy-Synthetic-Model"],
        capabilities: aliasCapabilities,
      }),
    ];

    expect(getProviderModelCapabilities(models, "legacy-synthetic-model", PROVIDER)).toEqual(
      aliasCapabilities,
    );
  });

  it("prefers an exact custom slug over a built-in model alias", () => {
    const customCapabilities = capabilities("custom-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["custom-model"],
        capabilities: capabilities("built-in-option"),
      }),
      model({ slug: "custom-model", capabilities: customCapabilities, isCustom: true }),
    ];

    expect(getProviderModelCapabilities(models, " custom-model ", PROVIDER)).toEqual(
      customCapabilities,
    );
  });

  it("returns empty capabilities for an unknown slug", () => {
    const models = [
      model({
        slug: "default-model",
        capabilities: capabilities("default-option"),
      }),
    ];

    expect(getProviderModelCapabilities(models, "unknown-model", PROVIDER)).toEqual({
      optionDescriptors: [],
    });
  });
});
