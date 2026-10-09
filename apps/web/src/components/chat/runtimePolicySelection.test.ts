import {
  PI_RUNTIME_POLICY_OPTION_ID,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";
import {
  carryRuntimePolicyForModelChange,
  resolveMultiModelRuntimePolicySelection,
  resolveRuntimePolicyPicker,
  selectRuntimePolicyChoice,
} from "./runtimePolicySelection";

const instanceId = ProviderInstanceId.make("pi-main");
const selection = createModelSelection(instanceId, "openai/gpt-5.4", [
  { id: "thinkingLevel", value: "high" },
]);
const policies = [
  { id: "auto", label: "AUTO", extensionName: "Safety", command: "pi-desktop-policy-auto" },
  {
    id: "review",
    label: "Review",
    extensionName: "Team",
    description: "Review tool use",
    command: "pi-desktop-policy-review",
  },
];
const provider = Schema.decodeSync(ServerProvider)({
  instanceId,
  driver: "pi",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-08T00:00:00.000Z",
  models: [],
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  runtimePolicies: policies,
});

describe("runtime policy selection", () => {
  it("excludes generic auto from shared built-ins while selecting bundled Auto Mode through its named policy", () => {
    expect(runtimeModeOptions).toEqual(["approval-required", "auto-accept-edits", "full-access"]);
    const desktopProvider = {
      ...provider,
      supportedRuntimeModes: [...provider.supportedRuntimeModes!, "auto" as const],
      runtimePolicies: [
        ...policies,
        {
          id: "desktop-auto",
          label: "Auto Mode",
          extensionName: "Pi Desktop Auto Mode",
          command: "pi-desktop-policy-desktop-auto",
        },
      ],
    };
    const picker = resolveRuntimePolicyPicker(desktopProvider, "approval-required", selection);
    expect(picker.choices.map((choice) => choice.value)).toEqual([
      ...runtimeModeOptions,
      "policy:auto",
      "policy:review",
      "policy:desktop-auto",
    ]);
    expect(picker.choices.filter((choice) => choice.label.startsWith("Auto Mode"))).toEqual([
      expect.objectContaining({
        value: "policy:desktop-auto",
        label: "Auto Mode · Pi Desktop Auto Mode",
      }),
    ]);
    const next = selectRuntimePolicyChoice(desktopProvider, selection, "policy:desktop-auto")!;
    expect(next.runtimeMode).toBe("auto");
    expect(next.modelSelection.options).toEqual([
      ...selection.options!,
      { id: PI_RUNTIME_POLICY_OPTION_ID, value: "desktop-auto" },
    ]);
    expect(
      resolveRuntimePolicyPicker(desktopProvider, next.runtimeMode, next.modelSelection),
    ).toMatchObject({ value: "policy:desktop-auto", blockedReason: null });
    expect(selectRuntimePolicyChoice(desktopProvider, selection, "auto")).toBeNull();
  });

  it("keeps legacy auto unavailable until a built-in or named policy is explicitly selected", () => {
    expect(runtimeModeConfig.auto.label).toBe("Unavailable mode · auto");
    const legacy = resolveRuntimePolicyPicker(provider, "auto", selection);
    expect(legacy.value).toBe("unavailable");
    expect(legacy.blockedReason).not.toBeNull();
    expect(legacy.choices.at(-1)).toMatchObject({
      label: runtimeModeConfig.auto.label,
      disabled: true,
    });
    expect(selectRuntimePolicyChoice(provider, selection, legacy.value)).toBeNull();
    expect(selection.options).toEqual([{ id: "thinkingLevel", value: "high" }]);
    const next = selectRuntimePolicyChoice(provider, selection, "auto-accept-edits")!;
    expect(next).toEqual({ runtimeMode: "auto-accept-edits", modelSelection: selection });
    expect(
      resolveRuntimePolicyPicker(provider, next.runtimeMode, next.modelSelection),
    ).toMatchObject({ value: "auto-accept-edits", blockedReason: null });
  });

  it("applies policy to every model of the same instance, retains each effort, and blocks cross-instance auto sends", () => {
    const primary = selectRuntimePolicyChoice(provider, selection, "policy:review")!.modelSelection;
    const second = createModelSelection(instanceId, "another/model", [
      { id: "thinkingLevel", value: "low" },
    ]);
    const multiple = resolveMultiModelRuntimePolicySelection(primary, "auto", [primary, second]);
    expect(multiple.blockedReason).toBeNull();
    expect(multiple.selections?.[1]?.options).toEqual([
      { id: "thinkingLevel", value: "low" },
      { id: PI_RUNTIME_POLICY_OPTION_ID, value: "review" },
    ]);
    const other = { ...second, instanceId: ProviderInstanceId.make("pi-other") };
    const ambiguous = resolveMultiModelRuntimePolicySelection(primary, "auto", [primary, other]);
    expect(ambiguous.blockedReason).toContain("same Pi instance");
    expect(ambiguous.selections?.[1]?.options).toEqual(second.options);
    const builtIn = resolveMultiModelRuntimePolicySelection(
      primary,
      "approval-required",
      multiple.selections,
    );
    expect(builtIn.selections?.[0]?.options).toEqual(selection.options);
    expect(builtIn.selections?.[1]?.options).toEqual(second.options);
  });
  it("shows three built-ins and distinct labels/origins without treating auto as a plugin", () => {
    const picker = resolveRuntimePolicyPicker(provider, "approval-required", selection);
    expect(picker.choices.map((choice) => choice.label)).toEqual([
      "Supervised",
      "Auto-accept edits",
      "Full access",
      "AUTO · Safety",
      "Review · Team",
    ]);
    expect(picker.value).toBe("approval-required");
    expect(picker.choices.some((choice) => choice.value === "auto")).toBe(false);
    expect(resolveRuntimePolicyPicker(provider, "auto", selection)).toMatchObject({
      value: "unavailable",
    });
    expect(selectRuntimePolicyChoice(provider, selection, "auto")).toBeNull();
  });

  it("switches between policies in the same internal auto slot and removes only the reserved option on exit", () => {
    const auto = selectRuntimePolicyChoice(provider, selection, "policy:auto")!;
    expect(auto.runtimeMode).toBe("auto");
    expect(auto.modelSelection.options).toEqual([
      ...selection.options!,
      { id: PI_RUNTIME_POLICY_OPTION_ID, value: "auto" },
    ]);
    const review = selectRuntimePolicyChoice(provider, auto.modelSelection, "policy:review")!;
    expect(review.runtimeMode).toBe("auto");
    expect(
      resolveRuntimePolicyPicker(provider, review.runtimeMode, review.modelSelection).value,
    ).toBe("policy:review");
    expect(
      review.modelSelection.options?.filter((option) => option.id === PI_RUNTIME_POLICY_OPTION_ID),
    ).toEqual([{ id: PI_RUNTIME_POLICY_OPTION_ID, value: "review" }]);
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"]) {
      expect(selectRuntimePolicyChoice(provider, review.modelSelection, mode)).toEqual({
        runtimeMode: mode,
        modelSelection: selection,
      });
    }
  });

  it("keeps deleted and legacy selections visibly unavailable and never defaults to another policy or full access", () => {
    const stale = createModelSelection(instanceId, selection.model, [
      { id: PI_RUNTIME_POLICY_OPTION_ID, value: "deleted" },
    ]);
    const picker = resolveRuntimePolicyPicker(provider, "auto", stale);
    expect(picker.value).toBe("unavailable");
    expect(picker.blockedReason).not.toBeNull();
    expect(picker.choices.at(-1)).toMatchObject({
      disabled: true,
      label: "Unavailable policy · deleted",
    });
    expect(stale.options).toEqual([{ id: PI_RUNTIME_POLICY_OPTION_ID, value: "deleted" }]);
    expect(selectRuntimePolicyChoice(provider, stale, "policy:deleted")).toBeNull();
    expect(resolveRuntimePolicyPicker(provider, "full-access", stale).value).toBe("unavailable");
  });

  it("uses workspace policies including authoritative empty lists, with legacy missing-field fallback only", () => {
    const scoped = {
      ...provider,
      workspaceSnapshots: [
        {
          cwd: "C:/empty",
          checkedAt: provider.checkedAt,
          skills: [],
          slashCommands: [],
          runtimePolicies: [],
        },
        { cwd: "C:/legacy", checkedAt: provider.checkedAt, skills: [], slashCommands: [] },
        {
          cwd: "C:/project",
          checkedAt: provider.checkedAt,
          skills: [],
          slashCommands: [],
          runtimePolicies: [policies[1]!],
        },
      ],
    };
    expect(
      resolveRuntimePolicyPicker(scoped, "approval-required", selection, "C:/empty").choices,
    ).toHaveLength(3);
    expect(selectRuntimePolicyChoice(scoped, selection, "policy:auto", "C:/empty")).toBeNull();
    expect(
      resolveRuntimePolicyPicker(scoped, "approval-required", selection, "C:/legacy").choices,
    ).toHaveLength(5);
    expect(
      resolveRuntimePolicyPicker(scoped, "approval-required", selection, "C:/project").choices.at(
        -1,
      )?.label,
    ).toBe("Review · Team");
    expect(
      selectRuntimePolicyChoice(scoped, selection, "policy:review", "C:/project")?.runtimeMode,
    ).toBe("auto");
  });

  it("keeps the last workspace policy during TTL/reload pending discovery rather than pretending removal", () => {
    const pending = {
      ...provider,
      workspaceSnapshots: [
        {
          cwd: "C:/project",
          checkedAt: "2020-01-01T00:00:00.000Z",
          skills: [],
          slashCommands: [],
          slashCommandsPending: true,
          runtimePolicies: [policies[1]!],
        },
      ],
    };
    const review = selectRuntimePolicyChoice(pending, selection, "policy:review", "C:/project")!;
    expect(
      resolveRuntimePolicyPicker(pending, "auto", review.modelSelection, "C:/project")
        .blockedReason,
    ).toBeNull();
  });

  it("preserves policy across models of the same Pi instance but strips remembered policies on instance switches", () => {
    const current = selectRuntimePolicyChoice(provider, selection, "policy:review")!.modelSelection;
    const next = createModelSelection(instanceId, "other/model", [
      { id: "thinkingLevel", value: "low" },
      { id: PI_RUNTIME_POLICY_OPTION_ID, value: "old-sticky" },
    ]);
    expect(carryRuntimePolicyForModelChange(current, next, provider).options).toEqual([
      { id: "thinkingLevel", value: "low" },
      { id: PI_RUNTIME_POLICY_OPTION_ID, value: "review" },
    ]);
    const other = { ...provider, instanceId: ProviderInstanceId.make("pi-other") };
    const switched = carryRuntimePolicyForModelChange(
      current,
      { ...next, instanceId: other.instanceId },
      other,
    );
    expect(switched.options).toEqual([{ id: "thinkingLevel", value: "low" }]);
    expect(resolveRuntimePolicyPicker(other, "auto", switched).value).toBe("unavailable");
    expect(selectRuntimePolicyChoice(other, current, "policy:review")).toBeNull();
  });
});
