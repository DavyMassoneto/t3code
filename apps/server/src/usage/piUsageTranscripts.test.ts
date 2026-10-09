// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { initialPiScanState, parsePiLine, parsePiRecord } from "./piUsageTranscripts.ts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";
import { decodeScanCache, encodeScanCache, type ScanCache } from "./usageScanCache.ts";
import { parseRateTable, priceUsage } from "./usagePricing.ts";
import { totalTokens } from "./usageTranscripts.ts";

const timestamp = "2026-08-01T10:00:00Z";
const usage = {
  input: 10,
  output: 20,
  cacheRead: 100,
  cacheWrite: 30,
  reasoning: 5,
  totalTokens: 160,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
};
const message = (provider = "anthropic", overrides: Record<string, unknown> = {}) => ({
  type: "message",
  id: "response-1",
  timestamp,
  message: { role: "assistant", provider, model: "test-model", usage, ...overrides },
});

describe("Pi native usage", () => {
  it.each(["anthropic", "openai", "xai", "custom-service"])(
    "preserves %s service identity and disjoint cache tokens",
    (provider) => {
      const record = parsePiRecord(message(provider), initialPiScanState());
      expect(record?.model).toBe(`${provider}/test-model`);
      expect(record?.provider).toBe("pi");
      expect(record?.totals).toEqual({
        uncachedInputTokens: 10,
        cachedInputTokens: 100,
        cacheCreationTokens: 30,
        outputTokens: 20,
        reasoningTokens: 5,
      });
      expect(totalTokens(record!.totals)).toBe(160);
      expect(record?.reportedCostUsd).toBe(0.1);
    },
  );

  it("retains reported zero instead of estimating from known rates", () => {
    const record = parsePiRecord(
      message("openai", { usage: { ...usage, cost: { total: 0 } } }),
      initialPiScanState(),
    )!;
    const rates = parseRateTable({
      "openai/test-model": { input_cost_per_token: 1, output_cost_per_token: 1 },
    });
    expect(priceUsage(rates, record)).toMatchObject({ costUsd: 0, costSource: "providerReported" });
    const unknown = parsePiRecord(
      message("custom-service", { usage: { input: 10, output: 20 } }),
      initialPiScanState(),
    )!;
    expect(unknown.reportedCostUsd).toBeNull();
    expect(priceUsage(rates, unknown)).toMatchObject({ costUsd: 0, costSource: "unpriced" });
  });

  it("attributes ancillary usage to the active model without counting context edits", () => {
    const state = initialPiScanState();
    parsePiRecord({ type: "session", id: "session-a" }, state);
    parsePiRecord({ type: "model_change", provider: "anthropic", modelId: "test-model" }, state);
    for (const type of ["compaction", "branch_summary"]) {
      expect(parsePiRecord({ type, id: type, timestamp, usage }, state)).toMatchObject({
        model: "anthropic/test-model",
        sessionId: "session-a",
        reportedCostUsd: 0.1,
      });
    }
    expect(
      parsePiRecord(
        { type: "usage", id: "warm", timestamp, provider: "custom", model: "other", usage },
        state,
      )?.model,
    ).toBe("custom/other");
    expect(parsePiRecord({ type: "context_edit", timestamp, usage }, state)).toBeNull();
    expect(parsePiRecord(message("openai", { role: "user" }), state)).toBeNull();
    expect(parsePiRecord(message("openai", { stopReason: "pending" }), state)).toBeNull();
    expect(parsePiRecord({ ...message(), timestamp: "bad" }, state)).toBeNull();
    expect(parsePiRecord(message("", { model: "" }), state)).toBeNull();
    expect(parsePiLine("{unfinished", state)).toBeNull();
  });

  it("streams, persists state, resumes appends and replays unfinished tails", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-usage-test-"));
    try {
      const file = NodePath.join(dir, "session.jsonl");
      const header = { type: "session", id: "session-a" };
      const model = { type: "model_change", provider: "anthropic", modelId: "test-model" };
      const rows = [header, model, message("anthropic", { content: "fixture".repeat(100_000) })];
      await NodeFSP.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const first = (await readTranscriptRecords(file, "pi", undefined, {
        streamingThresholdBytes: 16,
      }))!;
      expect(first.records).toHaveLength(1);
      expect(first.records[0]?.sessionId).toBe("session-a");
      const cache: ScanCache = new Map([
        [
          file,
          {
            size: (await NodeFSP.stat(file)).size,
            mtimeMs: 1,
            provider: "pi",
            records: first.records,
            tailRecords: first.tailRecords,
            position: first.position,
          },
        ],
      ]);
      const decoded = decodeScanCache(encodeScanCache(cache));
      expect(decoded).toEqual(cache);
      const corrupt = encodeScanCache(cache);
      expect(
        decodeScanCache({ ...corrupt, files: { [file]: { ...corrupt.files[file], ps: null } } })
          .size,
      ).toBe(0);
      const next = JSON.stringify({ type: "compaction", id: "compact", timestamp, usage });
      await NodeFSP.appendFile(file, next);
      const tail = (await readTranscriptRecords(file, "pi", decoded.get(file)!.position))!;
      expect(tail.resumed).toBe(true);
      expect(tail.records).toHaveLength(0);
      expect(tail.tailRecords[0]?.model).toBe("anthropic/test-model");
      await NodeFSP.appendFile(file, "\n");
      const complete = (await readTranscriptRecords(file, "pi", tail.position))!;
      expect(complete.records).toEqual(tail.tailRecords);
      expect(complete.tailRecords).toHaveLength(0);
      await NodeFSP.writeFile(file, JSON.stringify(message("xai")) + "\n");
      const replaced = (await readTranscriptRecords(file, "pi", complete.position))!;
      expect(replaced.resumed).toBe(false);
      expect(replaced.records[0]?.model).toBe("xai/test-model");
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
