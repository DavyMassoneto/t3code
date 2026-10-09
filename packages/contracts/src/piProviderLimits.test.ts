import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { PiProviderLimitMetric, PiProviderLimits } from "./piProviderLimits.ts";

const isMetric = Schema.is(PiProviderLimitMetric);
const isLimits = Schema.is(PiProviderLimits);

describe("Pi limits contracts", () => {
  const metric = { id: "balance", label: "Balance", unit: "USD" };
  it("accepts real zero and signed balances without inventing other fields", () => {
    for (const remaining of [0, -2.5, 9]) {
      expect(isMetric({ ...metric, remaining })).toBe(true);
    }
  });
  it("rejects nonfinite numbers and invalid duration", () => {
    for (const field of ["used", "limit", "remaining", "windowSeconds"]) {
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(isMetric({ ...metric, [field]: value })).toBe(false);
      }
    }
    expect(isMetric({ ...metric, windowSeconds: -1 })).toBe(false);
    expect(isMetric({ ...metric, windowSeconds: 0 })).toBe(true);
  });
  it("requires valid canonical ISO timestamps", () => {
    const limits = { status: "unsupported", source: "native-registry", metrics: [] };
    for (const checkedAt of ["garbage", "2026-02-30T00:00:00.000Z", "2026-01-01"]) {
      expect(isLimits({ ...limits, checkedAt })).toBe(false);
    }
    expect(isLimits({ ...limits, checkedAt: "2026-10-08T12:00:00.000Z" })).toBe(true);
    expect(isMetric({ ...metric, resetsAt: "bad" })).toBe(false);
  });
});
