import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  allowed: true,
  list: vi.fn(),
  effects: [] as Array<() => (() => void) | void>,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => (() => void) | void) => state.effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/piConnections", () => ({
  listPiConnections: { permissionAtom: () => undefined },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.list }));
vi.mock("../ui/button", () => ({ Button: "button" }));

import {
  PiConnectionsPanel,
  PiConnectionCredentialsForm,
  usePiConnections,
} from "./PiConnectionsPanel";

const instanceId = ProviderInstanceId.make("pi-work");
const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const value = {
  instanceId,
  connections: [
    {
      service: "custom",
      name: "Private custom service",
      configured: true,
      authMethods: ["api_key"],
      authentication: "managed-in-pi",
      limits: "unavailable",
      models: [{ slug: "custom/model", name: "Model", available: true }],
    },
  ],
};
const render = (environmentId = first) => {
  hooks.beginRender();
  return PiConnectionsPanel({ environmentId, instanceId });
};

const saveApiKey = vi.fn<(apiKey: string) => Promise<boolean>>();
const onSaved = vi.fn();
const renderCredentials = (
  environmentId = first,
  runtimeId = instanceId,
  service = "anthropic",
  canManage = true,
) => {
  hooks.beginRender();
  return PiConnectionCredentialsForm({
    environmentId,
    instanceId: runtimeId,
    service,
    canManage,
    onSaveApiKey: saveApiKey,
    onSaved,
  });
};
function fillCredentials() {
  let form = renderCredentials();
  const input = visitElements(
    form,
    (element) => element.props["aria-label"] === "anthropic API key",
  );
  if (!input) throw new Error("Missing API key input");
  (input.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "private-fixture-key" },
  });
  form = renderCredentials();
  const consent = visitElements(
    form,
    (element) => element.props["aria-label"] === "Consent to store or replace API key",
  );
  if (!consent) throw new Error("Missing explicit consent control");
  (consent.props.onChange as (event: { target: { checked: boolean } }) => void)({
    target: { checked: true },
  });
  return renderCredentials();
}

describe("Pi native connection panel", () => {
  beforeEach(() => {
    hooks.reset();
    state.allowed = true;
    state.list.mockReset();
    saveApiKey.mockReset();
    onSaved.mockReset();
    state.effects = [];
  });
  it("does not request native accounts without providers:manage", () => {
    state.allowed = false;
    expect(JSON.stringify(render())).toContain("providers:manage");
    state.effects[0]!();
    expect(state.list).not.toHaveBeenCalled();
  });
  it("routes discovery to the explicit environment and Pi instance", async () => {
    state.list.mockResolvedValue({ _tag: "Success", value });
    render();
    state.effects[0]!();
    await Promise.resolve();
    expect(state.list).toHaveBeenCalledWith({ environmentId: first, input: { instanceId } });
    expect(JSON.stringify(render())).toContain("Private custom service");
    expect(JSON.stringify(render())).not.toContain("Subscription quota unavailable");
    expect(JSON.stringify(render(second))).not.toContain("Private custom service");
  });
  it("ignores a response after its environment is abandoned", async () => {
    let resolveResponse!: (value: unknown) => void;
    state.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    render();
    const cleanup = state.effects[0]!();
    cleanup?.();
    render(second);
    resolveResponse({ _tag: "Success", value });
    await Promise.resolve();
    expect(JSON.stringify(render(second))).not.toContain("Private custom service");
  });
  it("does not discover connections for a missing runtime", () => {
    hooks.beginRender();
    expect(usePiConnections(first, null).result).toBeNull();
    state.effects[0]!();
    expect(state.list).not.toHaveBeenCalled();
  });
  it("rejects discovery returned for another runtime", async () => {
    state.list.mockResolvedValue({
      _tag: "Success",
      value: { ...value, instanceId: ProviderInstanceId.make("other") },
    });
    render();
    state.effects[0]!();
    await Promise.resolve();
    expect(JSON.stringify(render())).not.toContain("Private custom service");
    expect(JSON.stringify(render())).toContain("Connections could not be discovered");
  });
  it("hides cached native connections immediately when permission is revoked", async () => {
    state.list.mockResolvedValue({ _tag: "Success", value });
    render();
    state.effects[0]!();
    await Promise.resolve();
    expect(JSON.stringify(render())).toContain("Private custom service");
    state.allowed = false;
    expect(JSON.stringify(render())).not.toContain("Private custom service");
  });
  it("requires consent and clears the key before saving through the provided action", async () => {
    saveApiKey.mockResolvedValue(true);
    let form = renderCredentials();
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: () => {},
    });
    expect(saveApiKey).not.toHaveBeenCalled();
    form = fillCredentials();
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: () => {},
    });
    expect(JSON.stringify(renderCredentials())).not.toContain("private-fixture-key");
    await Promise.resolve();
    expect(saveApiKey).toHaveBeenCalledExactlyOnceWith("private-fixture-key");
    expect(onSaved).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderCredentials())).toContain("API key saved");
  });
  it.each(["environment", "instance", "service", "permission", "unmount"])(
    "discards key state and ignores a stale save after changing %s",
    async (change) => {
      let finish!: (saved: boolean) => void;
      saveApiKey.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      renderCredentials();
      const cleanup = state.effects[0]!();
      const form = fillCredentials();
      (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
        preventDefault: () => {},
      });
      const nextEnvironment = change === "environment" ? second : first;
      const nextInstance = change === "instance" ? ProviderInstanceId.make("other") : instanceId;
      const nextService = change === "service" ? "openai" : "anthropic";
      if (change === "unmount") cleanup?.();
      else renderCredentials(nextEnvironment, nextInstance, nextService, change !== "permission");
      finish(true);
      await Promise.resolve();
      expect(onSaved).not.toHaveBeenCalled();
      if (change !== "unmount") {
        const nextForm = renderCredentials(
          nextEnvironment,
          nextInstance,
          nextService,
          change !== "permission",
        );
        expect(JSON.stringify(nextForm)).not.toContain("private-fixture-key");
        expect(JSON.stringify(nextForm)).not.toContain("API key saved");
      }
    },
  );
  it("does not overwrite a new target's unsaved key when the old save completes", async () => {
    let finish!: (saved: boolean) => void;
    saveApiKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const form = fillCredentials();
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: () => {},
    });
    const nextForm = renderCredentials(second, instanceId, "openai");
    const input = visitElements(
      nextForm,
      (element) => element.props["aria-label"] === "openai API key",
    );
    if (!input) throw new Error("Missing next target's key input");
    expect(input.props.value).toBe("");
    (input.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "new-target-fixture-key" },
    });
    finish(true);
    await Promise.resolve();
    const newInput = visitElements(
      renderCredentials(second, instanceId, "openai"),
      (element) => element.props["aria-label"] === "openai API key",
    );
    expect(newInput?.props.value).toBe("new-target-fixture-key");
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("never displays a credential from a rejected save", async () => {
    saveApiKey.mockRejectedValue(new Error("private-fixture-key"));
    const form = fillCredentials();
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: () => {},
    });
    await Promise.resolve();
    expect(JSON.stringify(renderCredentials())).not.toContain("private-fixture-key");
    expect(JSON.stringify(renderCredentials())).toContain("Could not save the API key");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
