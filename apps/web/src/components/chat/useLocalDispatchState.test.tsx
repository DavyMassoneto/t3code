import { createElement, useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { useLocalDispatchState } from "./useLocalDispatchState";

const startedAt = "2026-10-08T10:00:00.000Z";
const runningThread = makeThreadFixture({
  modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "pi-default" },
  latestRun: {
    runId: RunId.make("pi-run"),
    status: "running",
    requestedAt: startedAt,
    startedAt,
    completedAt: null,
    assistantMessageId: null,
  },
  runtime: {
    status: "running",
    providerName: "pi",
    providerInstanceId: ProviderInstanceId.make("pi"),
    activeRunId: RunId.make("pi-run"),
    lastError: null,
    updatedAt: startedAt,
  },
});
type DispatchInput = Parameters<typeof useLocalDispatchState>[0];
const input: DispatchInput = {
  activeThread: runningThread,
  activeLatestRun: runningThread.latestRun,
  latestUserMessageId: MessageId.make("original-message"),
  phase: "running",
  activePendingApproval: null,
  activePendingUserInput: null,
  threadError: null,
};
let renderer: ReactTestRenderer;
let state: ReturnType<typeof useLocalDispatchState>;

function DispatchProbe({ input }: { input: DispatchInput }) {
  const dispatch = useLocalDispatchState(input);
  useLayoutEffect(() => {
    state = dispatch;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(createElement(DispatchProbe, { input }));
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("local Pi dispatch lifecycle", () => {
  it("releases send busy on a receipt without waiting for the running projection to change", async () => {
    let finish = () => {};
    await act(() => {
      finish = state.beginLocalDispatch();
    });
    expect(state.isSendBusy).toBe(true);
    expect(state.localDispatchStartedAt).not.toBeNull();
    await act(() => finish());
    expect(state.isSendBusy).toBe(false);
    expect(state.localDispatchStartedAt).toBeNull();
    expect(runningThread.runtime?.status).toBe("running");
    await act(() => {
      state.beginLocalDispatch();
    });
    expect(state.isSendBusy).toBe(true);
  });

  it("does not let an old receipt clear a newer dispatch after navigation or failure cleanup", async () => {
    let finishOld = () => {};
    let finishNew = () => {};
    await act(() => {
      finishOld = state.beginLocalDispatch();
    });
    await act(() => state.resetLocalDispatch());
    await act(() => {
      finishNew = state.beginLocalDispatch();
    });
    await act(() => finishOld());
    expect(state.isSendBusy).toBe(true);
    await act(() => finishNew());
    expect(state.isSendBusy).toBe(false);
  });

  it("still accepts a projected steering message before the receipt arrives", async () => {
    await act(() => {
      state.beginLocalDispatch();
    });
    expect(state.isSendBusy).toBe(true);
    await act(() => {
      renderer.update(
        createElement(DispatchProbe, {
          input: { ...input, latestUserMessageId: MessageId.make("steering-message") },
        }),
      );
    });
    expect(state.isSendBusy).toBe(false);
  });
});
