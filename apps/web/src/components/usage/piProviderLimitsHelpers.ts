import type { PiConnection, PiProviderLimitMetric } from "@t3tools/contracts";

export function groupPiProviderLimits(connections: readonly PiConnection[]) {
  const configured = connections.filter((connection) => connection.configured);
  return {
    available: configured.filter((connection) => connection.limitsDetails?.status === "available"),
    errors: configured.filter((connection) => connection.limitsDetails?.status === "error"),
    unsupported: configured.filter(
      (connection) =>
        !connection.limitsDetails || connection.limitsDetails.status === "unsupported",
    ),
  };
}

export function nativeMetricKind(metric: PiProviderLimitMetric) {
  const description = `${metric.id} ${metric.label}`;
  if (
    /(^|[\s_-])(rate|rpm|tpm|rpd|tpd)([\s_-]|$)|per[\s_-]+(minute|second|day)/i.test(description)
  ) {
    return "Rate limit";
  }
  if (/balance|credits?/i.test(description) || /^(usd|eur|gbp|diem|credits?)$/i.test(metric.unit)) {
    return "Balance";
  }
  if (/subscription/i.test(description)) return "Subscription quota";
  if (/^(requests?|tokens?)$/i.test(metric.unit)) return "Rate limit";
  return metric.windowSeconds !== undefined ? "Usage window" : "Provider metric";
}

export function formatNativeMetricValue(value: number, unit: string) {
  const currency = /^(usd|eur|gbp)$/i.test(unit);
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: currency ? 2 : 0,
    maximumFractionDigits: 2,
  })} ${unit}`;
}

export function formatNativeMetricExactValue(value: number, unit: string) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 20 })} ${unit}`;
}

export function nativeMetricProgress(metric: PiProviderLimitMetric) {
  const field = metric.used !== undefined ? "used" : "remaining";
  const amount = metric[field];
  if (amount === undefined) return null;
  const percentageUnit = /^(percent|percentage|%)$/i.test(metric.unit);
  if (!percentageUnit && !(metric.limit !== undefined && metric.limit > 0)) return null;
  const percent = percentageUnit ? amount : (amount / metric.limit!) * 100;
  return {
    percent,
    field,
    label: `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% ${field === "used" ? "used" : "left"}`,
  };
}

export function nativeUsageMetrics(metrics: readonly PiProviderLimitMetric[]) {
  return metrics.filter((metric) => {
    const kind = nativeMetricKind(metric);
    if (kind === "Rate limit") return false;
    if (kind === "Balance") return metric.remaining !== undefined;
    if (nativeMetricProgress(metric) === null) return false;
    return (
      kind === "Subscription quota" ||
      kind === "Usage window" ||
      /^(percent|percentage|%)$/i.test(metric.unit) ||
      metric.resetsAt !== undefined
    );
  });
}

export function formatNativeWindow(seconds: number) {
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
