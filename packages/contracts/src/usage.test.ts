import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { UsageBucket, UsageProviderKind } from "./usage.ts";

const decodeProvider = Schema.decodeSync(UsageProviderKind);
const decodeBucket = Schema.decodeSync(UsageBucket);

describe("usage provider history", () => {
  it.each(["claude", "codex", "grok", "cursor", "opencode", "antigravity", "pi"] as const)(
    "decodes %s without changing the legacy bucket shape",
    (provider) => {
      expect(decodeProvider(provider)).toBe(provider);
      expect(
        decodeBucket({
          day: "2026-08-01",
          provider,
          model: provider === "pi" ? "custom/model" : "model",
          totals: {
            uncachedInputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 2,
            reasoningTokens: 0,
          },
          costUsd: 0,
          cacheSavingsUsd: 0,
          costSource: "providerReported",
          records: 1,
          unpricedRecords: 0,
          sessions: 1,
        }).provider,
      ).toBe(provider);
    },
  );
});
