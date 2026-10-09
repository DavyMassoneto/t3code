import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";

import {
  alternateComposerDispatchAction,
  acquireComposerSend,
  acknowledgeComposerSend,
  resolveComposerDispatchMode,
} from "./composerDispatch.ts";

describe("composer send receipts", () => {
  it("allows another message after its own durable acknowledgment without the old RPC reply", () => {
    const inFlight = { current: false };
    const firstId = MessageId.make("first-message");
    const nextId = MessageId.make("next-message");
    const first = acquireComposerSend(inFlight, firstId)!;
    expect(acquireComposerSend(inFlight, nextId)).toBeNull();
    expect(
      acknowledgeComposerSend(inFlight, new Set([MessageId.make("other-client-message")])),
    ).toBe(false);
    expect(acquireComposerSend(inFlight, nextId)).toBeNull();
    expect(acknowledgeComposerSend(inFlight, new Set([firstId]))).toBe(true);
    const next = acquireComposerSend(inFlight, nextId);
    expect(next).not.toBeNull();
    expect(first.wasAcknowledged()).toBe(true);
    first.release();
    expect(inFlight.current).toBe(true);
    next!.release();
    expect(inFlight.current).toBe(false);
  });

  it("keeps unacknowledged sends locked and does not release a newer non-message operation", () => {
    const inFlight = { current: false };
    const send = acquireComposerSend(inFlight, MessageId.make("message"))!;
    expect(acknowledgeComposerSend(inFlight, new Set())).toBe(false);
    expect(send.wasAcknowledged()).toBe(false);
    send.release();
    inFlight.current = true;
    send.release();
    expect(inFlight.current).toBe(true);
  });
});

describe("resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ running: false, alternateModifier: false })).toBe("auto");
  });

  it("steers by default and reserves Mod+Enter for queueing while running", () => {
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: false })).toBe("steer");
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: true })).toBe("queue");
  });

  it("queues as the alternate action when restarting is the default", () => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "restart",
      }),
    ).toBe("restart");
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: true,
        activeTurnDefault: "restart",
      }),
    ).toBe("queue");
  });
  it.each([
    ["queue", "steer"],
    ["steer", "queue"],
  ] as const)(
    "uses configured %s behavior only during a running turn",
    (activeTurnDefault, alternateAction) => {
      expect(
        resolveComposerDispatchMode({
          running: true,
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe(activeTurnDefault);
      expect(
        resolveComposerDispatchMode({
          running: true,
          alternateModifier: true,
          activeTurnDefault,
        }),
      ).toBe(alternateAction);
      expect(
        resolveComposerDispatchMode({
          running: false,
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe("auto");
      expect(
        resolveComposerDispatchMode({ running: false, alternateModifier: true, activeTurnDefault }),
      ).toBe("auto");
    },
  );

  it("names the alternate action so the affordance can be labelled", () => {
    expect(alternateComposerDispatchAction("queue")).toBe("steer");
    expect(alternateComposerDispatchAction("steer")).toBe("queue");
    expect(alternateComposerDispatchAction()).toBe("queue");
  });
});
