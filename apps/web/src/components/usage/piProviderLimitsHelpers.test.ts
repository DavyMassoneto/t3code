import { describe, expect, it } from "vite-plus/test";
import {
  formatNativeMetricExactValue,
  formatNativeMetricValue,
  nativeMetricProgress,
  nativeUsageMetrics,
} from "./piProviderLimitsHelpers";

describe("native usage metric presentation", () => {
  it("uses locale currency precision while preserving the exact original value separately", () => {
    for (const value of [0, -11.65049819, 11.65049819]) {
      const compact = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
      expect(formatNativeMetricValue(value, "USD")).toBe(`${compact} USD`);
      expect(formatNativeMetricExactValue(value, "USD")).toBe(
        `${value.toLocaleString(undefined, { maximumFractionDigits: 20 })} USD`,
      );
    }
    expect(formatNativeMetricValue(0, "DIEM")).toBe("0 DIEM");
    expect(formatNativeMetricValue(1.23456789, "DIEM")).toBe(`${(1.23).toLocaleString()} DIEM`);
  });

  it("filters technical capacities and unmeasured metrics, including safe extension labels", () => {
    const metrics = [
      { id: "balance", label: "Extension metric1", unit: "DIEM", remaining: 0 },
      { id: "window", label: "Primary subscription window", unit: "percent", used: 0, limit: 100 },
      { id: "rpm", label: "RPM", unit: "requests", limit: 20 },
      { id: "tpm", label: "TPM", unit: "tokens", remaining: 20, limit: 100 },
      { id: "rpd", label: "RPD", unit: "requests", used: 30, limit: 1000, windowSeconds: 86400 },
      {
        id: "extension-2",
        label: "Extension metric2",
        unit: "requests",
        used: 30,
        limit: 1000,
        windowSeconds: 86400,
      },
      { id: "unknown", label: "Subscription capacity", unit: "percent", limit: 100 },
      { id: "unknown-balance", label: "USD balance", unit: "USD", limit: 100, used: 0 },
    ];
    expect(nativeUsageMetrics(metrics).map((metric) => metric.id)).toEqual(["balance", "window"]);
  });

  it("uses measured usage or remaining shares without manufacturing missing counters", () => {
    expect(
      nativeMetricProgress({
        id: "used",
        label: "Subscription tokens",
        unit: "tokens",
        used: 25,
        limit: 100,
      }),
    ).toEqual({ percent: 25, field: "used", label: "25% used" });
    expect(
      nativeMetricProgress({
        id: "remaining",
        label: "Weekly window",
        unit: "percent",
        remaining: 0,
      }),
    ).toEqual({ percent: 0, field: "remaining", label: "0% left" });
    expect(
      nativeMetricProgress({
        id: "zero",
        label: "Subscription tokens",
        unit: "tokens",
        used: 0,
        limit: 0,
      }),
    ).toBeNull();
    expect(
      nativeMetricProgress({ id: "capacity", label: "Window", unit: "percent", limit: 100 }),
    ).toBeNull();
  });
});
