import type { MessageId } from "@t3tools/contracts";

/**
 * How a composer submission is delivered when the thread already has a turn in
 * flight. Shared by web (where the alternate is Mod+Enter) and mobile (where it
 * is a long-press on the send button), so both clients agree on what the user's
 * configured follow-up behavior means.
 */
export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/** The alternate switches between queue and steer relative to the configured action. */
export function resolveComposerDispatchMode(input: {
  /** A turn is in flight, so the follow-up has to queue behind it or steer it. */
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

/** What the alternate would do, for labelling the affordance that triggers it. */
export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}

interface ComposerSendReceipt {
  readonly messageId: MessageId;
  readonly release: () => void;
  readonly acknowledge: () => void;
  readonly wasAcknowledged: () => boolean;
}

const composerSendReceipts = new WeakMap<{ current: boolean }, ComposerSendReceipt>();

export function acquireComposerSend(inFlight: { current: boolean }, messageId: MessageId) {
  if (inFlight.current) return null;
  inFlight.current = true;
  let acknowledged = false;
  const receipt: ComposerSendReceipt = {
    messageId,
    release: () => {
      if (composerSendReceipts.get(inFlight) !== receipt) return;
      composerSendReceipts.delete(inFlight);
      inFlight.current = false;
    },
    acknowledge: () => {
      acknowledged = true;
      receipt.release();
    },
    wasAcknowledged: () => acknowledged,
  };
  composerSendReceipts.set(inFlight, receipt);
  return receipt;
}

export function acknowledgeComposerSend(
  inFlight: { current: boolean },
  committedMessageIds: ReadonlySet<MessageId>,
) {
  const receipt = composerSendReceipts.get(inFlight);
  if (receipt === undefined || !committedMessageIds.has(receipt.messageId)) return false;
  receipt.acknowledge();
  return true;
}
