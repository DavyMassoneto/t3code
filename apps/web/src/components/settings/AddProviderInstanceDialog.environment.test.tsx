import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const actions = vi.hoisted(() => ({
  update: vi.fn(),
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  canManageProviders: true,
}));

const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  mutate: vi.fn(),
  useMutation: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation,
}));

vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return { ...actual, useEnvironmentScope: hasScope, readEnvironmentScope: hasScope };
});

vi.mock("../ui/toast", () => ({ toastManager: { add: actions.toast } }));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");
function render(onOpenChange = vi.fn()) {
  hooks.beginRender();
  return AddProviderInstanceDialog({
    open: true,
    environmentId: remoteEnvironmentId,
    environmentLabel: "Remote device",
    onOpenChange,
  });
}

function findByChildren(tree: ReturnType<typeof render>, children: string) {
  const result = visitElements(tree, (element) => element.props.children === children);
  expect(result).not.toBeNull();
  return result!;
}

function renderDialog() {
  hooks.beginRender();
  return AddProviderInstanceDialog({
    open: true,
    environmentId: remoteEnvironmentId,
    environmentLabel: "Remote device",
    onOpenChange: actions.onOpenChange,
  });
}

function button(dialog: unknown, label: string) {
  const element = visitElements(
    dialog,
    (entry) => entry.props.children === label && typeof entry.props.onClick === "function",
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

function prepareInstance() {
  let dialog = renderDialog();
  (button(dialog, "Next").props.onClick as () => void)();
  dialog = renderDialog();
  const label = visitElements(dialog, (entry) => entry.props.placeholder === "e.g. Work");
  if (!label) throw new Error("Missing instance label input.");
  (label.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "Work" },
  });
  dialog = renderDialog();
  (button(dialog, "Next").props.onClick as () => void)();
  return renderDialog();
}

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    actions.canManageProviders = true;
    actions.toast.mockReset();
    actions.onOpenChange.mockReset();
    settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
    settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
  });

  it("creates a provider with its default identity without typing", async () => {
    let tree = render();
    const group = visitElements(
      tree,
      (element) => element.props["aria-labelledby"] === "add-instance-driver-label",
    );
    (group!.props.onValueChange as (value: string) => void)("pi");
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "pi_2",
      instance: { driver: "pi", enabled: true, displayName: "Pi" },
    });
  });

  it("chooses an unused identity for another account without replacing configured instances", async () => {
    settingsHooks.read.mockReturnValue({
      providerInstances: {
        pi_2: { driver: "pi", enabled: false },
      },
    });
    let tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "pi_3",
      instance: {
        driver: "pi",
        enabled: true,
        displayName: "Pi",
      },
    });
  });

  it("reads and writes settings through the supplied environment", () => {
    render();

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
  });

  it("awaits an atomic Pi create before closing", async () => {
    let resolveMutation!: (value: { readonly _tag: "Success"; readonly value: unknown }) => void;
    settingsHooks.mutate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    resolveMutation({ _tag: "Success", value: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not offer ACP registry, local commands, or ChatGPT harness creation", () => {
    const dialog = renderDialog();
    expect(
      visitElements(
        dialog,
        (element) =>
          typeof element.type === "function" && element.type.name === "AcpRegistrySearchStep",
      ),
    ).toBeNull();
    expect(
      visitElements(dialog, (element) => element.props.children === "Configure manually"),
    ).toBeNull();
    expect(
      visitElements(dialog, (element) => element.props.children === "Connect ChatGPT"),
    ).toBeNull();
  });

  it("keeps the dialog open when the atomic create fails", async () => {
    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    const dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
  });

  it("adds an instance with the selected environment's provider grant alone", async () => {
    const dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();

    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "pi_work",
      instance: {
        driver: "pi",
        enabled: true,
        displayName: "Work",
      },
    });
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Provider instance added" }),
    );
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rejects a queued save after the provider grant is revoked", () => {
    const dialog = prepareInstance();
    const save = button(dialog, "Add instance").props.onClick as () => void;
    actions.canManageProviders = false;
    save();

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(button(renderDialog(), "Add instance").props.disabled).toBe(true);
  });

  it("keeps a denied draft available when the provider grant arrives", async () => {
    actions.canManageProviders = false;
    let dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();
    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();

    actions.canManageProviders = true;
    dialog = renderDialog();
    expect(button(dialog, "Add instance").props.disabled).toBe(false);
    (button(dialog, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledOnce();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });
});
