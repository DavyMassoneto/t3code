import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  presentThreadShell,
  resolveThreadWorkingStartedAt,
  threadRuntimeIsActive,
} from "./models.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";
import { isThreadWorking } from "./threadInbox.ts";

const startedAt = DateTime.makeUnsafe("2026-10-08T10:00:00.000Z");
const retryAt = DateTime.makeUnsafe("2026-10-08T10:00:10.000Z");
const lateAt = DateTime.makeUnsafe("2026-10-08T10:00:20.000Z");
const runningRun: OrchestrationV2Run = {
  id: RunId.make("retry-run"),
  threadId: v2Projection.thread.id,
  ordinal: 1,
  providerInstanceId: v2Projection.thread.providerInstanceId,
  modelSelection: v2Projection.thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("retry-message"),
  rootNodeId: NodeId.make("retry-root"),
  activeAttemptId: null,
  status: "running",
  requestedAt: startedAt,
  startedAt,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const retryItem: Extract<OrchestrationV2TurnItem, { type: "error" }> = {
  id: TurnItemId.make("provider-retry"),
  threadId: runningRun.threadId,
  runId: runningRun.id,
  nodeId: runningRun.rootNodeId,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  type: "error",
  status: "running",
  title: "Provider retry",
  startedAt: retryAt,
  completedAt: null,
  updatedAt: retryAt,
  failure: {
    class: "provider_error",
    message: "The model is currently at capacity due to high demand.",
    code: null,
    retryable: true,
  },
  retry: { attempt: 1, maxAttempts: 3, retryDelayMs: 1000 },
};

describe("provider retry lifecycle presentation", () => {
  it.each(["provider_error", "transport_error", "usage_limit"] as const)(
    "keeps a live %s retry working and interruptible without resetting its timer",
    (failureClass) => {
      const projection = applyOrchestrationV2ProjectionEvent(
        { ...v2Projection, runs: [runningRun] },
        {
          id: EventId.make("retry-start"),
          type: "turn-item.updated",
          threadId: runningRun.threadId,
          runId: runningRun.id,
          occurredAt: retryAt,
          payload: { ...retryItem, failure: { ...retryItem.failure, class: failureClass } },
        },
      )!;
      const runtime = deriveThreadRuntime(projection);
      const latestRun = deriveThreadActivityRun(projection);
      expect(runtime).toMatchObject({
        status: "running",
        activeRunId: runningRun.id,
        lastError: null,
      });
      expect(threadRuntimeIsActive(runtime)).toBe(true);
      expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
      expect(
        isThreadWorking({
          runtime,
          latestRun,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          interactionMode: "default",
        }),
      ).toBe(true);
      expect(resolveThreadWorkingStartedAt({ runtime, latestRun })).toBe(
        DateTime.formatIso(startedAt),
      );
      const recovered = applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("retry-recovered"),
        type: "turn-item.updated",
        threadId: runningRun.threadId,
        runId: runningRun.id,
        occurredAt: lateAt,
        payload: { ...retryItem, status: "completed", completedAt: lateAt, updatedAt: lateAt },
      })!;
      expect(deriveThreadRuntime(recovered)).toMatchObject({
        status: "running",
        activeRunId: runningRun.id,
      });
    },
  );

  it("does not revive a terminal failure from late tools or retry items without a run lifecycle update", () => {
    const failedRun = { ...runningRun, status: "failed" as const, completedAt: retryAt };
    const failedItem = { ...retryItem, status: "failed" as const, completedAt: retryAt };
    const failed = applyOrchestrationV2ProjectionEvent(
      { ...v2Projection, runs: [runningRun], turnItems: [failedItem] },
      {
        id: EventId.make("run-failed"),
        type: "run.updated",
        threadId: runningRun.threadId,
        runId: runningRun.id,
        occurredAt: retryAt,
        payload: failedRun,
      },
    )!;
    const lateTool: OrchestrationV2TurnItem = {
      ...retryItem,
      id: TurnItemId.make("late-tool"),
      ordinal: 2,
      type: "command_execution",
      input: "pwd",
      output: "",
      startedAt: lateAt,
      updatedAt: lateAt,
    };
    for (const item of [lateTool, { ...retryItem, updatedAt: lateAt }]) {
      const updated = applyOrchestrationV2ProjectionEvent(failed, {
        id: EventId.make(`late-${item.id}`),
        type: "turn-item.updated",
        threadId: runningRun.threadId,
        runId: runningRun.id,
        occurredAt: lateAt,
        payload: item,
      })!;
      expect(updated.runs).toBe(failed.runs);
      expect(updated.turnItems).toContainEqual(item);
      expect(deriveThreadActivityRun(updated)?.status).toBe("failed");
      const runtime = deriveThreadRuntime(updated);
      expect(runtime).toMatchObject({
        status: "failed",
        activeRunId: null,
        activityStartedAt: null,
      });
      expect(threadRuntimeIsActive(runtime)).toBe(false);
      expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
    }
    const resumed = applyOrchestrationV2ProjectionEvent(failed, {
      id: EventId.make("run-resumed"),
      type: "run.updated",
      threadId: runningRun.threadId,
      runId: runningRun.id,
      occurredAt: lateAt,
      payload: runningRun,
    })!;
    expect(deriveThreadRuntime(resumed)).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
      lastError: null,
    });
    expect(threadRuntimeHasInterruptibleRun(deriveThreadRuntime(resumed))).toBe(true);
  });

  it.each(["running", "failed"] as const)(
    "presents a %s shell according to lifecycle rather than its error text",
    (status) => {
      const shell = presentThreadShell(EnvironmentId.make("retry-environment"), {
        ...v2ThreadShell,
        latestRunId: runningRun.id,
        activeRunId: status === "running" ? runningRun.id : null,
        status,
        activityRunStatus: status === "running" ? status : null,
        activityRunStartedAt: status === "running" ? startedAt : null,
        lastError: retryItem.failure.message,
        lastErrorClass: "provider_error",
      });
      expect(shell.runtime?.lastError).toBe(retryItem.failure.message);
      expect(threadRuntimeIsActive(shell.runtime)).toBe(status === "running");
      expect(threadRuntimeHasInterruptibleRun(shell.runtime)).toBe(status === "running");
      expect(isThreadWorking(shell)).toBe(status === "running");
    },
  );
});
