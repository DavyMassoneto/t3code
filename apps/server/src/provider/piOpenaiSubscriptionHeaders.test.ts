import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { PiProviderLimits } from "@t3tools/contracts";
import { PI_OPENAI_SUBSCRIPTION_HEADERS_SOURCE } from "./piOpenaiSubscriptionHeaders.ts";

const readHeaders = new Function(
  `${PI_OPENAI_SUBSCRIPTION_HEADERS_SOURCE}\nreturn readOpenaiSubscriptionHeaders;`,
)() as (headers: Record<string, string>, checkedAt: string) => unknown;
const decodeLimits = Schema.decodeUnknownSync(PiProviderLimits);
const checkedAt = "2026-10-08T18:00:00.000Z";

describe("native OpenAI subscription response headers", () => {
  it("preserves actual percent, window and reset values with the observation timestamp", () => {
    const limits = decodeLimits(
      readHeaders(
        {
          "X-Codex-Primary-Used-Percent": "42.5",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": "1791482400",
          "x-codex-secondary-used-percent": "0",
          "x-codex-secondary-window-minutes": "10080",
        },
        checkedAt,
      ),
    );
    expect(limits.checkedAt).toBe(checkedAt);
    expect(limits.source).toBe("openai-inference-response-headers");
    expect(limits.metrics[0]).toMatchObject({
      id: "primary",
      used: 42.5,
      limit: 100,
      unit: "percent",
      windowSeconds: 18000,
    });
    expect(limits.metrics[1]).toEqual({
      id: "secondary",
      label: "Secondary subscription window",
      unit: "percent",
      used: 0,
      limit: 100,
      windowSeconds: 604800,
    });
    expect(readHeaders({ "x-codex-primary-used-percent": "42.5" }, checkedAt)).toMatchObject({
      checkedAt,
    });
  });

  it("ignores platform RPM/TPM and empty or nonfinite quota fields", () => {
    for (const headers of [
      { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-tokens": "20000" },
      { "x-codex-primary-used-percent": "" },
      { "x-codex-primary-used-percent": "NaN" },
      { "x-codex-primary-used-percent": "Infinity" },
      { "x-codex-primary-used-percent": "0x64" },
    ])
      expect(readHeaders(headers, checkedAt)).toBeUndefined();
  });

  it("requires credit metadata and an explicit finite balance rather than making up zero", () => {
    expect(readHeaders({ "x-codex-credits-balance": "7.5" }, checkedAt)).toBeUndefined();
    expect(
      readHeaders(
        {
          "x-codex-credits-has-credits": "true",
          "x-codex-credits-unlimited": "true",
          "x-codex-credits-balance": "7.5",
        },
        checkedAt,
      ),
    ).toBeUndefined();
    const limits = decodeLimits(
      readHeaders(
        {
          "x-codex-credits-has-credits": "false",
          "x-codex-credits-unlimited": "false",
          "x-codex-credits-balance": "0",
        },
        checkedAt,
      ),
    );
    expect(limits.metrics).toEqual([
      { id: "balance", label: "Credit balance", unit: "credits", remaining: 0 },
    ]);
  });

  it("omits invalid duration and reset fields without losing the reported utilization", () => {
    const limits = decodeLimits(
      readHeaders(
        {
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-window-minutes": "-1",
          "x-codex-primary-reset-at": "99999999999999999999999",
        },
        checkedAt,
      ),
    );
    expect(limits.metrics).toEqual([
      {
        id: "primary",
        label: "Primary subscription window",
        unit: "percent",
        used: 100,
        limit: 100,
      },
    ]);
  });

  it("never exports arbitrary headers and rejects a fabricated or invalid observation date", () => {
    const limits = readHeaders(
      {
        authorization: "NEVER_EXPORT_NATIVE_TOKEN",
        "x-account-id": "NEVER_EXPORT_ACCOUNT",
        "x-codex-primary-used-percent": "3",
      },
      checkedAt,
    );
    expect(JSON.stringify(limits)).not.toContain("NEVER_EXPORT");
    for (const time of ["", "today", "2026-02-30T00:00:00.000Z"])
      expect(readHeaders({ "x-codex-primary-used-percent": "3" }, time)).toBeUndefined();
  });
});
