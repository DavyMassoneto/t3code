export default function piDesktopAutoMode(pi) {
  const policyId = "desktop-auto";
  const warning =
    "Auto Mode automatically approves all tool calls for this session, including arbitrary shell commands, file reads and writes, and network access. There is no sandbox. Automatic approvals are NOT a model autonomous loop or retry mechanism and are NOT a security sandbox. Other extensions' approval hooks and UI requests still apply.";
  const descriptor = {
    id: policyId,
    label: "Auto Mode",
    extensionName: "Pi Desktop Auto Mode",
    description: warning,
  };
  let active = false;
  let revision = 0;

  const status = () =>
    active ? "Auto Mode: active (all tools auto-approved; no sandbox)" : "Auto Mode: inactive";

  const updateStatus = (ctx) => {
    try {
      ctx.ui.setStatus?.("pi-desktop-auto-mode", status());
    } catch {}
  };

  const transition = async (action, ctx) => {
    const requestRevision = ++revision;
    active = false;
    updateStatus(ctx);
    if (action === "deactivate") return true;
    try {
      const approved = await ctx.ui.confirm("Enable Auto Mode?", warning);
      if (requestRevision !== revision) return false;
      active = approved === true;
    } catch {
      if (requestRevision !== revision) return false;
      active = false;
    }
    updateStatus(ctx);
    return active;
  };

  pi.on("session_start", (_event, ctx) => {
    revision++;
    active = false;
    updateStatus(ctx);
  });

  pi.registerCommand("pi-desktop-policy-desktop-auto", {
    description: `pi-desktop-policy/v1:${JSON.stringify(descriptor)}`,
    handler: async (args, ctx) => {
      if (typeof args !== "string") return;
      const [action, requestId, extra] = args.trim().split(/\s+/);
      if (
        (action !== "activate" && action !== "deactivate") ||
        extra !== undefined ||
        requestId === undefined ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)
      )
        return;
      const requestRevision = revision + 1;
      const success =
        (await transition(action, ctx)) &&
        requestRevision === revision &&
        active === (action === "activate");
      ctx.ui.notify(
        "PI_DESKTOP_POLICY_ACK:" + JSON.stringify({ requestId, policyId, action, success }),
        "info",
      );
    },
  });

  pi.registerCommand("desktop-auto", {
    description:
      "Auto Mode: status, on, or off. Automatic approvals only; no sandbox or autonomous loop.",
    handler: async (args, ctx) => {
      if (typeof args !== "string") return;
      const action = args.trim() || "status";
      if (action === "status") {
        updateStatus(ctx);
        ctx.ui.notify(status(), "info");
        return;
      }
      if (action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /desktop-auto [status|on|off]", "warning");
        return;
      }
      if (typeof process !== "undefined" && process.env?.T3_PI_POLICY_TOKEN !== undefined) {
        ctx.ui.notify(
          "Auto Mode is managed by Pi Desktop. Change the selected runtime policy there.",
          "warning",
        );
        return;
      }
      await transition(action === "on" ? "activate" : "deactivate", ctx);
      ctx.ui.notify(status(), "info");
    },
  });
}
