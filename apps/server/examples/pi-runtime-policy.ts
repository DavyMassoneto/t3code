import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const policyId = "example-auto";
const command = `pi-desktop-policy-${policyId}`;
const ackPrefix = "PI_DESKTOP_POLICY_ACK:";
const descriptor = {
  id: policyId,
  label: "Example Auto",
  extensionName: "Pi Desktop example policy",
  description: "Allows reads and edits; asks before other tools.",
};

export default function exampleRuntimePolicy(pi: ExtensionAPI) {
  let active = false;
  pi.on("session_start", () => {
    active = false;
  });
  pi.registerCommand(command, {
    description: `pi-desktop-policy/v1:${JSON.stringify(descriptor)}`,
    handler: async (args, ctx) => {
      const [action, requestId, extra] = args.trim().split(/\s+/);
      if (
        (action !== "activate" && action !== "deactivate") ||
        extra !== undefined ||
        requestId === undefined ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)
      )
        return;
      active = false;
      let success = false;
      try {
        if (action === "activate") {
          success = await ctx.ui.confirm("Enable Example Auto?", descriptor.description);
          active = success;
        } else {
          success = true;
        }
      } catch {
        active = false;
      }
      ctx.ui.notify(ackPrefix + JSON.stringify({ requestId, policyId, action, success }), "info");
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!active) return;
    if (["read", "grep", "find", "ls", "edit", "write"].includes(event.toolName)) return;
    if (
      event.toolName === "tool_search" &&
      pi
        .getAllTools()
        .some(
          (tool) => tool.name === "tool_search" && tool.sourceInfo?.path === "builtin:tool-search",
        )
    )
      return;
    const approved = await ctx.ui.confirm(
      `Example Auto: allow ${event.toolName}?`,
      JSON.stringify(event.input).slice(0, 4_000),
    );
    if (!approved) return { block: true, reason: "Declined by the example runtime policy." };
  });
}
