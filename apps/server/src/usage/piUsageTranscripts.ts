import type { UsageRecord } from "./usageTranscripts.ts";

export interface PiScanState {
  sessionId: string;
  provider: string;
  model: string;
}

export function initialPiScanState(): PiScanState {
  return { sessionId: "", provider: "", model: "" };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parsePiLine(line: string, state: PiScanState): UsageRecord | null {
  try {
    return parsePiRecord(JSON.parse(line), state);
  } catch {
    return null;
  }
}

export function parsePiRecord(parsed: unknown, state: PiScanState): UsageRecord | null {
  const entry = object(parsed);
  if (entry === null) return null;
  if (entry.type === "session") {
    if (typeof entry.id === "string") state.sessionId = entry.id;
    return null;
  }
  if (entry.type === "model_change") {
    if (typeof entry.provider === "string") state.provider = entry.provider;
    if (typeof entry.modelId === "string") state.model = entry.modelId;
    return null;
  }
  let source: Record<string, unknown>;
  if (entry.type === "message") {
    const message = object(entry.message);
    if (message === null || message.role !== "assistant" || message.stopReason === "pending") {
      return null;
    }
    source = message;
  } else if (
    entry.type === "usage" ||
    entry.type === "compaction" ||
    entry.type === "branch_summary"
  ) {
    source = entry;
  } else {
    return null;
  }
  const usage = object(source.usage);
  if (usage === null) return null;
  const provider = typeof source.provider === "string" ? source.provider : state.provider;
  const model = typeof source.model === "string" ? source.model : state.model;
  if (!provider || !model) return null;
  const timestampMs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(timestampMs)) return null;
  const cost = object(usage.cost)?.total;
  const outputTokens = tokens(usage.output);
  return {
    provider: "pi",
    timestampMs,
    model: `${provider}/${model}`,
    sessionId: state.sessionId,
    totals: {
      uncachedInputTokens: tokens(usage.input),
      cachedInputTokens: tokens(usage.cacheRead),
      cacheCreationTokens: tokens(usage.cacheWrite),
      outputTokens,
      reasoningTokens: Math.min(outputTokens, tokens(usage.reasoning)),
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    speed: "standard",
    dedupeKey:
      typeof entry.id === "string" && entry.id.length > 0
        ? `${entry.id}:${timestampMs}:${provider}/${model}`
        : null,
  };
}
