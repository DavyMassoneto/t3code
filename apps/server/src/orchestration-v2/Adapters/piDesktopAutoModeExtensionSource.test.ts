import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import type {
  PiDesktopAutoModeAPI,
  PiDesktopAutoModeContext,
} from "../../../../../extensions/pi-desktop-auto-mode/index.mjs";
import { parsePiRuntimePolicies } from "../../provider/PiCommands.ts";
import {
  PI_DESKTOP_AUTO_MODE_EXTENSION_FILENAME,
  PI_DESKTOP_AUTO_MODE_EXTENSION_SOURCE,
} from "./piDesktopAutoModeExtensionSource.ts";

function loadExtension(options: { readonly token?: string; readonly status?: boolean } = {}) {
  const commands = new Map<string, Parameters<PiDesktopAutoModeAPI["registerCommand"]>[1]>();
  const hooks = new Map<
    string,
    Array<(event: unknown, ctx: PiDesktopAutoModeContext) => unknown>
  >();
  const notifications: Array<{ message: string; severity: string; status: string | undefined }> =
    [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const statuses = new Map<string, string | undefined>();
  let confirm: () => Promise<boolean> = async () => true;
  const ctx: PiDesktopAutoModeContext = {
    ui: {
      confirm: async (title, message) => {
        confirmations.push({ title, message });
        return confirm();
      },
      notify: (message, severity) => {
        notifications.push({ message, severity, status: statuses.get("pi-desktop-auto-mode") });
      },
      ...(options.status === false
        ? {}
        : { setStatus: (key: string, text: string | undefined) => statuses.set(key, text) }),
    },
  };
  const environment = Object.freeze(
    options.token === undefined ? {} : { T3_PI_POLICY_TOKEN: options.token },
  );
  const factory = NodeVM.runInNewContext(
    `(${PI_DESKTOP_AUTO_MODE_EXTENSION_SOURCE.replace(/^export default /, "")})`,
    { process: Object.freeze({ env: environment }) },
  ) as (pi: PiDesktopAutoModeAPI) => void;
  factory({
    on: (event, handler) => hooks.set(event, [...(hooks.get(event) ?? []), handler]),
    registerCommand: (name, command) => commands.set(name, command),
  });
  const invoke = (name: string, args: string) => {
    const command = commands.get(name);
    assert.isDefined(command);
    return command!.handler(args, ctx);
  };
  const emit = async (event: string, payload: unknown = {}) => {
    const results = [];
    for (const handler of hooks.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  };
  const ack = () => {
    const notification = notifications.at(-1);
    assert.isDefined(notification);
    assert.equal(notification!.severity, "info");
    assert.isTrue(notification!.message.startsWith("PI_DESKTOP_POLICY_ACK:"));
    return JSON.parse(notification!.message.slice("PI_DESKTOP_POLICY_ACK:".length)) as {
      requestId: string;
      policyId: string;
      action: string;
      success: boolean;
    };
  };
  return {
    commands,
    hooks,
    notifications,
    confirmations,
    statuses,
    ctx,
    environment,
    invoke,
    emit,
    ack,
    policy: (args: string) => invoke("pi-desktop-policy-desktop-auto", args),
    cli: (args: string) => invoke("desktop-auto", args),
    setConfirm: (handler: () => Promise<boolean>) => {
      confirm = handler;
    },
  };
}

describe("Pi Desktop Auto Mode generated native extension", () => {
  it("advertises an explicit discoverable policy and remains passive on load", async () => {
    const extension = loadExtension();
    assert.equal(PI_DESKTOP_AUTO_MODE_EXTENSION_FILENAME, "pi-desktop-auto-mode-extension.mjs");
    const catalog = [...extension.commands].map(([name, command]) => ({
      name,
      description: command.description,
      source: "extension",
    }));
    const policies = parsePiRuntimePolicies({ commands: catalog });
    assert.equal(policies.length, 1);
    assert.equal(policies[0]?.id, "desktop-auto");
    assert.equal(policies[0]?.label, "Auto Mode");
    assert.equal(policies[0]?.extensionName, "Pi Desktop Auto Mode");
    assert.deepEqual(extension.confirmations, []);
    assert.deepEqual(extension.notifications, []);
    await extension.cli("status");
    assert.equal(extension.notifications.at(-1)?.message, "Auto Mode: inactive");
  });

  it("confirms once and emits a correlated positive ACK only after active status", async () => {
    const extension = loadExtension();
    let resolveConfirmation!: (approved: boolean) => void;
    extension.setConfirm(
      () =>
        new Promise((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const activation = extension.policy(" activate request-123 ");
    assert.deepEqual(extension.notifications, []);
    assert.equal(extension.statuses.get("pi-desktop-auto-mode"), "Auto Mode: inactive");
    assert.equal(extension.confirmations.length, 1);
    const confirmation = extension.confirmations[0]!;
    assert.equal(confirmation.title, "Enable Auto Mode?");
    for (const text of [
      "arbitrary shell",
      "file reads and writes",
      "network access",
      "no sandbox",
      "NOT a model autonomous loop",
      "retry",
      "NOT a security sandbox",
    ]) {
      assert.include(confirmation.message, text);
    }
    resolveConfirmation(true);
    await activation;
    assert.deepEqual(extension.ack(), {
      requestId: "request-123",
      policyId: "desktop-auto",
      action: "activate",
      success: true,
    });
    assert.include(extension.notifications.at(-1)!.status!, "active (all tools auto-approved");
  });

  it.each(["declined", "error", "missing-confirm"])(
    "fails activation safely when %s",
    async (failure) => {
      const extension = loadExtension();
      await extension.policy("activate first");
      if (failure === "missing-confirm") {
        Object.defineProperty(extension.ctx.ui, "confirm", { value: undefined });
      } else {
        extension.setConfirm(async () => {
          if (failure === "error") throw new Error("UI unavailable");
          return false;
        });
      }
      await extension.policy("activate rejected");
      assert.deepEqual(extension.ack(), {
        requestId: "rejected",
        policyId: "desktop-auto",
        action: "activate",
        success: false,
      });
      assert.equal(extension.notifications.at(-1)?.status, "Auto Mode: inactive");
    },
  );

  it("ignores malformed arguments without state changes or uncorrelated ACKs", async () => {
    const extension = loadExtension();
    await extension.policy("activate valid");
    const count = extension.notifications.length;
    for (const args of [
      "",
      "activate",
      "deactivate",
      "on request",
      "activate request extra",
      "deactivate bad_id",
      "activate bad/id",
      `activate ${"a".repeat(129)}`,
    ]) {
      await extension.policy(args);
    }
    assert.equal(extension.notifications.length, count);
    assert.equal(extension.confirmations.length, 1);
    assert.include(extension.statuses.get("pi-desktop-auto-mode")!, "active (");
  });

  it("deactivates idempotently without confirmation and ACKs the established state", async () => {
    const extension = loadExtension();
    await extension.policy("activate first");
    for (const requestId of ["off-1", "off-2"]) {
      await extension.policy(`deactivate ${requestId}`);
      assert.deepEqual(extension.ack(), {
        requestId,
        policyId: "desktop-auto",
        action: "deactivate",
        success: true,
      });
      assert.equal(extension.notifications.at(-1)?.status, "Auto Mode: inactive");
    }
    assert.equal(extension.confirmations.length, 1);
  });

  it("resets on session_start with state isolated per factory invocation", async () => {
    const first = loadExtension();
    const second = loadExtension();
    await first.policy("activate first");
    await second.cli("status");
    assert.equal(second.notifications.at(-1)?.message, "Auto Mode: inactive");
    await first.emit("session_start");
    assert.equal(first.statuses.get("pi-desktop-auto-mode"), "Auto Mode: inactive");
    await first.policy("activate next-session");
    assert.equal(first.confirmations.length, 2);
    assert.isTrue(first.ack().success);
  });

  it.each(["session_start", "deactivate"])(
    "invalidates pending activation on %s",
    async (operation) => {
      const extension = loadExtension();
      let resolveConfirmation!: (approved: boolean) => void;
      extension.setConfirm(
        () =>
          new Promise((resolve) => {
            resolveConfirmation = resolve;
          }),
      );
      const activation = extension.policy("activate pending");
      if (operation === "session_start") await extension.emit("session_start");
      else await extension.policy("deactivate cancel");
      resolveConfirmation(true);
      await activation;
      assert.equal(extension.ack().requestId, "pending");
      assert.isFalse(extension.ack().success);
      assert.equal(extension.statuses.get("pi-desktop-auto-mode"), "Auto Mode: inactive");
    },
  );

  it("does not ACK success if a session reset occurs just before ACK publication", async () => {
    const extension = loadExtension();
    Object.defineProperty(extension.ctx.ui, "setStatus", {
      value: (key: string, text: string) => {
        extension.statuses.set(key, text);
        if (text.includes("active (")) queueMicrotask(() => void extension.emit("session_start"));
      },
    });
    await extension.policy("activate reset-before-ack");
    assert.equal(extension.ack().requestId, "reset-before-ack");
    assert.isFalse(extension.ack().success);
    assert.equal(extension.notifications.at(-1)?.status, "Auto Mode: inactive");
  });

  it("preserves a newer activation when an older confirmation completes", async () => {
    const extension = loadExtension();
    let resolveConfirmation!: (approved: boolean) => void;
    extension.setConfirm(
      () =>
        new Promise((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const oldActivation = extension.policy("activate old");
    extension.setConfirm(async () => true);
    await extension.policy("activate new");
    resolveConfirmation(false);
    await oldActivation;
    assert.equal(extension.ack().requestId, "old");
    assert.isFalse(extension.ack().success);
    assert.include(extension.statuses.get("pi-desktop-auto-mode")!, "active (");
  });

  it("supports native CLI status/on/off and optional or failing native status UI", async () => {
    for (const status of [true, false]) {
      const extension = loadExtension({ status });
      if (status)
        Object.defineProperty(extension.ctx.ui, "setStatus", {
          value: () => {
            throw new Error("Unavailable");
          },
        });
      await extension.cli("");
      assert.equal(extension.notifications.at(-1)?.message, "Auto Mode: inactive");
      await extension.cli("on");
      assert.include(extension.notifications.at(-1)!.message, "active (");
      await extension.cli("off");
      assert.equal(extension.notifications.at(-1)?.message, "Auto Mode: inactive");
      assert.equal(extension.confirmations.length, 1);
      await extension.cli("invalid");
      assert.include(extension.notifications.at(-1)!.message, "Usage:");
    }
  });

  it.each(["desktop-token", ""])(
    "prevents manual state changes when the Desktop token is set (%s)",
    async (token) => {
      const extension = loadExtension({ token });
      await extension.cli("on");
      assert.equal(extension.confirmations.length, 0);
      assert.include(extension.notifications.at(-1)!.message, "managed by Pi Desktop");
      await extension.policy("activate desktop");
      await extension.cli("off");
      await extension.cli("status");
      assert.include(extension.notifications.at(-1)!.message, "active (");
      assert.equal(extension.environment.T3_PI_POLICY_TOKEN, token);
      assert.isTrue(Object.isFrozen(extension.environment));
    },
  );

  it("does not repeatedly confirm tools or auto-answer or override other extension UI/hooks", async () => {
    const extension = loadExtension();
    assert.deepEqual([...extension.hooks.keys()], ["session_start"]);
    const otherApproval = async () => {
      const approved = await extension.ctx.ui.confirm("Other extension", "Allow this tool?");
      return approved ? undefined : { block: true, reason: "Other extension declined" };
    };
    extension.hooks.set("tool_call", [otherApproval]);
    extension.setConfirm(async () => false);
    assert.deepEqual(await extension.emit("tool_call"), [
      { block: true, reason: "Other extension declined" },
    ]);
    extension.setConfirm(async () => true);
    await extension.policy("activate tools");
    const count = extension.confirmations.length;
    extension.hooks.set("tool_call", []);
    for (const toolName of ["bash", "read", "write", "network", "custom-extension-tool"]) {
      assert.deepEqual(await extension.emit("tool_call", { toolName, input: {} }), []);
    }
    assert.equal(extension.confirmations.length, count);
    extension.hooks.set("tool_call", [otherApproval]);
    extension.setConfirm(async () => false);
    assert.deepEqual(await extension.emit("tool_call"), [
      { block: true, reason: "Other extension declined" },
    ]);
    assert.equal(extension.confirmations.at(-1)?.title, "Other extension");
    assert.deepEqual([...extension.hooks.keys()].sort(), ["session_start", "tool_call"]);
  });
});
