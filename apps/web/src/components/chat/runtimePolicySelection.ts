import {
  PI_RUNTIME_POLICY_OPTION_ID,
  type ModelSelection,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { SparklesIcon, LockIcon } from "lucide-react";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";

export type RuntimePolicyChoice = {
  value: string;
  label: string;
  description: string;
  icon: (typeof runtimeModeConfig)[RuntimeMode]["icon"];
  disabled?: boolean;
};

const policyValue = (id: string) => `policy:${id}`;

export function selectedRuntimePolicyId(selection: ModelSelection): string | undefined {
  const value = selection.options?.find(
    (option) => option.id === PI_RUNTIME_POLICY_OPTION_ID,
  )?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function withoutRuntimePolicy(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): ProviderOptionSelection[] {
  return options?.filter((option) => option.id !== PI_RUNTIME_POLICY_OPTION_ID) ?? [];
}

export function resolveRuntimePolicyPicker(
  provider: ServerProvider | null | undefined,
  mode: RuntimeMode,
  selection: ModelSelection,
  cwd?: string | null,
): { choices: RuntimePolicyChoice[]; value: string; blockedReason: string | null } {
  const sameInstance = provider?.instanceId === selection.instanceId;
  const policies =
    sameInstance && provider?.driver === "pi" ? runtimePoliciesForCwd(provider, cwd) : [];
  const supported = provider?.supportedRuntimeModes;
  const choices: RuntimePolicyChoice[] = runtimeModeOptions
    .filter((candidate) => !supported?.length || supported.includes(candidate))
    .map((candidate) => ({ value: candidate, ...runtimeModeConfig[candidate] }));
  for (const policy of policies) {
    choices.push({
      value: policyValue(policy.id),
      label:
        policy.id === "desktop-auto" && policy.command === "pi-desktop-policy-desktop-auto"
          ? "Auto Mode"
          : `${policy.label} · ${policy.extensionName}`,
      description: policy.description ?? `Runtime policy from ${policy.extensionName}.`,
      icon: SparklesIcon,
    });
  }
  const policyId = selectedRuntimePolicyId(selection);
  const validPolicy = policies.find((policy) => policy.id === policyId);
  if (mode === "auto" && validPolicy) {
    return { choices, value: policyValue(validPolicy.id), blockedReason: null };
  }
  if (
    selection.options?.some((option) => option.id === PI_RUNTIME_POLICY_OPTION_ID) ||
    mode === "auto" ||
    !choices.some((choice) => choice.value === mode)
  ) {
    const value = "unavailable";
    const blockedReason = policyId
      ? "This runtime policy is unavailable or inconsistent. Select an access policy before sending."
      : "This access mode is unavailable. Select an access policy before sending.";
    choices.push({
      value,
      label: policyId ? `Unavailable policy · ${policyId}` : `Unavailable mode · ${mode}`,
      description: blockedReason,
      icon: LockIcon,
      disabled: true,
    });
    return { choices, value, blockedReason };
  }
  return { choices, value: mode, blockedReason: null };
}

export function selectRuntimePolicyChoice(
  provider: ServerProvider | null | undefined,
  selection: ModelSelection,
  value: string,
  cwd?: string | null,
): { runtimeMode: RuntimeMode; modelSelection: ModelSelection } | null {
  const options = withoutRuntimePolicy(selection.options);
  if (value.startsWith("policy:")) {
    const policy =
      provider?.instanceId === selection.instanceId && provider.driver === "pi"
        ? runtimePoliciesForCwd(provider, cwd).find(
            (candidate) => policyValue(candidate.id) === value,
          )
        : undefined;
    if (!policy) return null;
    return {
      runtimeMode: "auto",
      modelSelection: createModelSelection(selection.instanceId, selection.model, [
        ...options,
        { id: PI_RUNTIME_POLICY_OPTION_ID, value: policy.id },
      ]),
    };
  }
  if (value !== "approval-required" && value !== "auto-accept-edits" && value !== "full-access") {
    return null;
  }
  if (provider?.supportedRuntimeModes?.length && !provider.supportedRuntimeModes.includes(value)) {
    return null;
  }
  return {
    runtimeMode: value,
    modelSelection: createModelSelection(selection.instanceId, selection.model, options),
  };
}

export function runtimePoliciesForCwd(provider: ServerProvider, cwd?: string | null) {
  const workspace = cwd
    ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)
    : undefined;
  return workspace?.runtimePolicies ?? provider.runtimePolicies ?? [];
}

export function carryRuntimePolicyForModelChange(
  current: ModelSelection,
  next: ModelSelection,
  provider: ServerProvider | undefined,
): ModelSelection {
  const policyId =
    provider?.driver === "pi" && current.instanceId === next.instanceId
      ? selectedRuntimePolicyId(current)
      : undefined;
  const options = withoutRuntimePolicy(next.options);
  if (policyId) options.push({ id: PI_RUNTIME_POLICY_OPTION_ID, value: policyId });
  return createModelSelection(next.instanceId, next.model, options);
}

export function resolveMultiModelRuntimePolicySelection(
  primary: ModelSelection,
  mode: RuntimeMode,
  selections: ReadonlyArray<ModelSelection> | null,
): { selections: ReadonlyArray<ModelSelection> | null; blockedReason: string | null } {
  if (selections === null) return { selections, blockedReason: null };
  const policyId = selectedRuntimePolicyId(primary);
  if (
    mode === "auto" &&
    (!policyId || selections.some((selection) => selection.instanceId !== primary.instanceId))
  ) {
    return {
      selections,
      blockedReason:
        "Runtime policies require all selected models to use the same Pi instance. Choose a built-in access mode or models from one instance.",
    };
  }
  return {
    selections: selections.map((selection) => {
      const options = withoutRuntimePolicy(selection.options);
      if (mode === "auto" && policyId)
        options.push({ id: PI_RUNTIME_POLICY_OPTION_ID, value: policyId });
      return createModelSelection(selection.instanceId, selection.model, options);
    }),
    blockedReason: null,
  };
}
