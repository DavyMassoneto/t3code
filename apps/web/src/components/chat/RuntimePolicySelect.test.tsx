import { createContext, useContext, type ReactNode } from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ServerProvider, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

vi.mock("../ui/select", async () => {
  const React = await import("react");
  const Context = React.createContext({
    value: "",
    disabled: false,
    onValueChange: (_value: string) => {},
  });
  return {
    Select: ({
      children,
      value,
      disabled = false,
      onValueChange,
    }: {
      children: ReactNode;
      value: string;
      disabled?: boolean;
      onValueChange: (value: string) => void;
    }) => (
      <Context.Provider value={{ value, disabled, onValueChange }}>{children}</Context.Provider>
    ),
    SelectItem: ({
      children,
      value,
      disabled = false,
    }: {
      children: ReactNode;
      value: string;
      disabled?: boolean;
    }) => {
      const state = React.useContext(Context);
      return (
        <button
          aria-checked={state.value === value}
          disabled={disabled || state.disabled}
          onClick={() => {
            if (!disabled && !state.disabled) state.onValueChange(value);
          }}
        >
          {children}
        </button>
      );
    },
    SelectPopup: ({ children }: { children: ReactNode }) => children,
    SelectValue: ({ children }: { children: ReactNode }) => (
      <span data-selected-label>{children}</span>
    ),
  };
});
vi.mock("../ui/menu", async () => {
  const React = await import("react");
  const Context = React.createContext({ value: "", onValueChange: (_value: string) => {} });
  const Wrapper = ({ children }: { children?: ReactNode }) => children;
  return {
    Menu: Wrapper,
    MenuPopup: Wrapper,
    MenuTrigger: Wrapper,
    MenuSeparator: () => null,
    MenuRadioGroup: ({
      children,
      value,
      onValueChange,
    }: {
      children: ReactNode;
      value: string;
      onValueChange: (value: string) => void;
    }) => <Context.Provider value={{ value, onValueChange }}>{children}</Context.Provider>,
    MenuRadioItem: ({
      children,
      value,
      disabled = false,
    }: {
      children: ReactNode;
      value: string;
      disabled?: boolean;
    }) => {
      const state = React.useContext(Context);
      return (
        <button
          aria-checked={state.value === value}
          disabled={disabled}
          onClick={() => {
            if (!disabled) state.onValueChange(value);
          }}
        >
          {children}
        </button>
      );
    },
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("./ComposerControl", () => ({
  ComposerControl: () => null,
  ComposerSelectControl: () => null,
  ComposerControlIcon: () => null,
}));
vi.mock("./composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));

import { useComposerDraftStore } from "../../composerDraftStore";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { RuntimePolicySelect } from "./RuntimePolicySelect";
import { getComposerProviderState } from "./composerProviderState";
import { resolveRuntimePolicyPicker, selectRuntimePolicyChoice } from "./runtimePolicySelection";

const instanceId = ProviderInstanceId.make("pi-main");
const target = scopeThreadRef(EnvironmentId.make("policy-test"), ThreadId.make("policy-test"));
const base = createModelSelection(instanceId, "model", [{ id: "thinkingLevel", value: "high" }]);
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
  runtimePolicies: [
    { id: "auto", label: "AUTO", extensionName: "Safety", command: "pi-desktop-policy-auto" },
    { id: "review", label: "Review", extensionName: "Team", command: "pi-desktop-policy-review" },
  ],
});
const SnapshotContext = createContext(provider);

function PickerHarness({ compact, busy = false }: { compact: boolean; busy?: boolean }) {
  const snapshot = useContext(SnapshotContext);
  const draft = useComposerDraftStore((state) => state.getComposerDraft(target));
  const selection = draft?.modelSelectionByProvider[instanceId] ?? base;
  const mode = draft?.runtimeMode ?? "approval-required";
  const picker = resolveRuntimePolicyPicker(snapshot, mode, selection, "C:/project");
  const onValueChange = (value: string) => {
    const next = selectRuntimePolicyChoice(snapshot, selection, value, "C:/project");
    if (next)
      useComposerDraftStore.getState().setModelSelection(target, next.modelSelection, {
        explicit: true,
        replaceOptions: true,
        runtimeMode: next.runtimeMode,
      });
  };
  return compact ? (
    <CompactComposerControlsMenu
      interactionMode="default"
      runtimeMode={picker.value}
      runtimeModeOptions={picker.choices}
      runtimePolicyDisabled={busy}
      showInteractionModeToggle={false}
      onToggleInteractionMode={() => {}}
      onRuntimeModeChange={onValueChange}
    />
  ) : (
    <RuntimePolicySelect
      value={picker.value}
      choices={picker.choices}
      disabled={busy}
      onValueChange={onValueChange}
    />
  );
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
});
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  renderer = undefined;
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  vi.unstubAllGlobals();
});

function buttonWithLabel(label: string) {
  const textContent = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : textContent(child))).join("");
  return renderer!.root
    .findAllByType("button")
    .find((button) => textContent(button).includes(label))!;
}

async function renderPicker(compact: boolean, busy = false, snapshot = provider) {
  await act(() => {
    const element = (
      <SnapshotContext.Provider value={snapshot}>
        <PickerHarness compact={compact} busy={busy} />
      </SnapshotContext.Provider>
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

describe.each([
  { compact: false, name: "desktop/inline" },
  { compact: true, name: "compact" },
])("$name runtime policy selector", ({ compact }) => {
  it("selects bundled Auto Mode by its short title without conflating third-party policies", async () => {
    const snapshot = {
      ...provider,
      runtimePolicies: [
        ...provider.runtimePolicies!,
        {
          id: "desktop-auto",
          label: "Auto Mode",
          extensionName: "Pi Desktop Auto Mode",
          command: "pi-desktop-policy-desktop-auto",
        },
        {
          id: "team-auto",
          label: "Auto Mode",
          extensionName: "Team",
          description: `Review each tool. ${"long-third-party-metadata".repeat(200)}`,
          command: "team-auto",
        },
        {
          id: "safety-auto",
          label: "Auto Mode",
          extensionName: "Safety",
          command: "safety-auto",
        },
      ],
    };
    await renderPicker(compact, false, snapshot);
    for (const [label, policyId] of [
      ["Auto Mode", "desktop-auto"],
      ["Auto Mode · Team", "team-auto"],
      ["Auto Mode · Safety", "safety-auto"],
    ]) {
      await act(() => buttonWithLabel(label!).props.onClick());
      const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
      expect(draft.runtimeMode).toBe("auto");
      expect(draft.modelSelectionByProvider[instanceId]?.options).toEqual([
        ...base.options!,
        { id: "piRuntimePolicy", value: policyId },
      ]);
      expect(buttonWithLabel(label!).props["aria-checked"]).toBe(true);
      expect(buttonWithLabel("Full access").props["aria-checked"]).toBe(false);
    }
    await act(() => buttonWithLabel("Auto-accept edits").props.onClick());
    const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(draft.runtimeMode).toBe("auto-accept-edits");
    expect(draft.modelSelectionByProvider[instanceId]?.options).toEqual(base.options);
  });

  it("selects distinct plugin labels and origins, switches within auto, and returns to a built-in without losing effort", async () => {
    await renderPicker(compact);
    await act(() => buttonWithLabel("AUTO · Safety").props.onClick());
    let draft = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(draft.runtimeMode).toBe("auto");
    expect(draft.modelSelectionByProvider[instanceId]?.options).toEqual([
      ...base.options!,
      { id: "piRuntimePolicy", value: "auto" },
    ]);
    expect(buttonWithLabel("AUTO · Safety").props["aria-checked"]).toBe(true);
    await act(() => buttonWithLabel("Review · Team").props.onClick());
    draft = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(draft.runtimeMode).toBe("auto");
    expect(draft.modelSelectionByProvider[instanceId]?.options).toEqual([
      ...base.options!,
      { id: "piRuntimePolicy", value: "review" },
    ]);
    expect(buttonWithLabel("Review · Team").props["aria-checked"]).toBe(true);
    const dispatch = getComposerProviderState({
      provider: provider.driver,
      model: "model",
      models: [],
      modelOptions: draft.modelSelectionByProvider[instanceId]?.options,
      planModeEnabled: false,
    });
    expect(dispatch.modelOptionsForDispatch).toEqual([{ id: "piRuntimePolicy", value: "review" }]);
    await act(() => buttonWithLabel("Supervised").props.onClick());
    draft = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(draft.runtimeMode).toBe("approval-required");
    expect(draft.modelSelectionByProvider[instanceId]?.options).toEqual(base.options);
    expect(buttonWithLabel("Supervised").props["aria-checked"]).toBe(true);
  });

  it("does not permit access changes while busy", async () => {
    await renderPicker(compact, true);
    expect(buttonWithLabel("Review · Team").props.disabled).toBe(true);
    await act(() => buttonWithLabel("Review · Team").props.onClick());
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
  });

  it("honors workspace removal even while global policies remain installed", async () => {
    await renderPicker(compact);
    await act(() => buttonWithLabel("Review · Team").props.onClick());
    await renderPicker(compact, false, {
      ...provider,
      workspaceSnapshots: [
        {
          cwd: "C:/project",
          checkedAt: provider.checkedAt,
          slashCommands: [],
          skills: [],
          runtimePolicies: [],
        },
      ],
    });
    expect(buttonWithLabel("Review · Team")).toBeUndefined();
    expect(buttonWithLabel("Unavailable policy · review").props["aria-checked"]).toBe(true);
    await act(() => buttonWithLabel("Supervised").props.onClick());
    expect(
      useComposerDraftStore.getState().getComposerDraft(target)?.modelSelectionByProvider[
        instanceId
      ]?.options,
    ).toEqual(base.options);
  });

  it("shows a removed selection as unavailable and requires an explicit built-in choice", async () => {
    await renderPicker(compact);
    await act(() => buttonWithLabel("Review · Team").props.onClick());
    await renderPicker(compact, false, { ...provider, runtimePolicies: [] });
    expect(buttonWithLabel("Unavailable policy · review").props["aria-checked"]).toBe(true);
    expect(buttonWithLabel("Unavailable policy · review").props.disabled).toBe(true);
    expect(buttonWithLabel("Full access").props["aria-checked"]).toBe(false);
    const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(
      resolveRuntimePolicyPicker(
        { ...provider, runtimePolicies: [] },
        draft.runtimeMode!,
        draft.modelSelectionByProvider[instanceId]!,
      ).blockedReason,
    ).not.toBeNull();
    await act(() => buttonWithLabel("Auto-accept edits").props.onClick());
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.runtimeMode).toBe(
      "auto-accept-edits",
    );
    expect(
      useComposerDraftStore.getState().getComposerDraft(target)?.modelSelectionByProvider[
        instanceId
      ]?.options,
    ).toEqual(base.options);
  });
});
