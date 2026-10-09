// @vitest-environment jsdom
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderAuthState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  cancelAllowed: true,
  executionAllowed: true,
  auth: null as ProviderAuthState | null,
  queryError: null as string | null,
  queryPending: false,
  queryFailure: null as ProviderSetupError | EnvironmentAuthorizationError | null,
  start: vi.fn(),
  cancel: vi.fn(),
  respond: vi.fn(),
  refresh: vi.fn(),
  open: vi.fn(),
  authenticated: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => {
    if (typeof atom === "string")
      return atom === "cancel-permission" ? state.cancelAllowed : state.allowed;
    if (!atom || !("environmentId" in Object(atom))) return AsyncResult.initial(false);
    if (state.queryError !== null)
      return AsyncResult.failure(Cause.fail(state.queryFailure ?? new Error(state.queryError)), {
        waiting: state.queryPending,
      });
    return state.auth
      ? AsyncResult.success(state.auth, { waiting: state.queryPending })
      : AsyncResult.initial(state.queryPending);
  },
  useAtomRefresh: () => state.refresh,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    startProviderAuth: { label: "start", permissionAtom: () => "start-permission" },
    cancelProviderAuth: { label: "cancel", permissionAtom: () => "cancel-permission" },
    respondProviderAuth: { label: "respond", permissionAtom: () => "respond-permission" },
    providerAuthState: (target: unknown) => target,
  },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed && state.executionAllowed,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "start"
      ? state.start
      : command.label === "cancel"
        ? state.cancel
        : state.respond,
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.open } }),
}));

import { PiOpenaiUsageAuth } from "./PiOpenaiUsageAuth";
import { usePiOpenaiUsageAuth } from "../../state/piOpenaiUsageAuth";

const environmentId = EnvironmentId.make("remote-one");
const otherEnvironment = EnvironmentId.make("remote-two");
const instanceId = ProviderInstanceId.make("pi-work");
const otherInstance = ProviderInstanceId.make("pi-home");
function auth(
  phase: ProviderAuthState["phase"] = "idle",
  selectedInstance = instanceId,
): ProviderAuthState {
  return {
    instanceId: selectedInstance,
    phase,
    flowId: phase === "idle" ? null : "flow-one",
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    methods: [
      {
        id: "pi-openai-quota-device",
        name: "Subscription",
        description: null,
        type: "credentials",
      },
    ],
    interaction:
      phase === "waiting"
        ? {
            type: "deviceCode",
            id: "interaction-one",
            url: "https://auth.openai.com/codex/device",
            userCode: "ABCD-EFGH",
          }
        : null,
  };
}
const success = (value: ProviderAuthState) => ({ _tag: "Success" as const, value });
function deferred() {
  let resolve!: (value: ReturnType<typeof success>) => void;
  const promise = new Promise<ReturnType<typeof success>>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function CommitClick({
  children,
  onCommit,
}: {
  children: ReactNode;
  onCommit?: (() => void) | undefined;
}) {
  useLayoutEffect(() => onCommit?.());
  return children;
}

describe("native OpenAI subscription authorization", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async (
    environment = environmentId,
    instance = instanceId,
    service = "openai",
    readOnly = false,
    onCommit?: () => void,
  ) => {
    await act(() =>
      root.render(
        <CommitClick onCommit={onCommit}>
          <PiOpenaiUsageAuth
            environmentId={environment}
            instanceId={instance}
            service={service}
            readOnly={readOnly}
            onAuthenticated={state.authenticated}
          />
        </CommitClick>,
      ),
    );
  };
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === label,
    )!;
  const click = async (label: string) => {
    await act(() => button(label).click());
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = true;
    state.cancelAllowed = true;
    state.executionAllowed = true;
    state.queryError = null;
    state.queryPending = false;
    state.queryFailure = null;
    state.auth = auth();
    for (const mock of [
      state.start,
      state.cancel,
      state.respond,
      state.refresh,
      state.open,
      state.authenticated,
    ])
      mock.mockReset();
    state.start.mockResolvedValue(success(auth("waiting")));
    state.cancel.mockResolvedValue(success(auth("cancelled")));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it("starts the advertised method for the exact environment/runtime without reporting acceptance as success", async () => {
    await render();
    await click("Connect OpenAI usage");
    expect(state.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, methodId: "pi-openai-quota-device" },
    });
    expect(state.authenticated).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
    expect(container.textContent).toContain("does not change your model authentication");
    expect(container.querySelector("details")?.textContent).toContain(
      "not automatically matched or merged",
    );
  });
  it("dispatches from a waiting Success subscription and stays visibly starting until status arrives", async () => {
    state.queryPending = true;
    const pending = deferred();
    state.start.mockReturnValue(pending.promise);
    await render();
    expect(button("Connect OpenAI usage").disabled).toBe(false);
    await click("Connect OpenAI usage");
    expect(state.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, methodId: "pi-openai-quota-device" },
    });
    expect(button("Starting\u2026").disabled).toBe(true);
    await act(() => pending.resolve(success(auth("waiting"))));
    expect(button("Starting\u2026").disabled).toBe(true);
    state.auth = auth();
    await render();
    expect(button("Starting\u2026").disabled).toBe(true);
    state.auth = auth("waiting");
    await render();
    expect(container.querySelector("code")?.textContent).toBe("ABCD-EFGH");
    await click("Cancel sign-in");
    expect(state.cancel).toHaveBeenCalledTimes(1);
  });
  it("dispatches a committed click when permission is restored before passive effects", async () => {
    const pending = deferred();
    state.start.mockReturnValue(pending.promise);
    state.allowed = false;
    await render();
    state.allowed = true;
    await render(environmentId, instanceId, "openai", false, () => {
      button("Connect OpenAI usage")?.click();
    });
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(button("Starting\u2026").disabled).toBe(true);
    await act(() => pending.resolve(success(auth("waiting"))));
    expect(state.cancel).not.toHaveBeenCalled();
    expect(button("Starting\u2026").disabled).toBe(true);
    state.auth = auth("waiting");
    await render();
    expect(container.querySelector("code")?.textContent).toBe("ABCD-EFGH");
  });
  it("explains execution-time permission revocation rather than silently ignoring the click", async () => {
    await render();
    state.executionAllowed = false;
    await click("Connect OpenAI usage");
    expect(state.start).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Check status and permissions");
  });
  it("suppresses duplicate clicks while visibly starting and releases a failed command for retry", async () => {
    state.queryPending = true;
    state.start.mockRejectedValueOnce(new Error("private failure"));
    await render();
    await act(() => {
      button("Connect OpenAI usage").click();
      container.querySelector("button")?.click();
    });
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Could not start native OpenAI usage sign-in");
    expect(button("Connect OpenAI usage").disabled).toBe(false);
    await click("Connect OpenAI usage");
    expect(state.start).toHaveBeenCalledTimes(2);
    expect(button("Starting\u2026").disabled).toBe(true);
  });
  it("visibly explains initial status loading and does not dispatch without a supported snapshot", async () => {
    state.auth = null;
    state.queryPending = true;
    await render();
    expect(button("Connect OpenAI usage").disabled).toBe(true);
    expect(container.textContent).toContain("Reading native usage sign-in status");
    await click("Connect OpenAI usage");
    expect(state.start).not.toHaveBeenCalled();
  });
  it.each(["equivalent", "unsupported", "active", "wrong-instance", "query-failure"])(
    "checks live semantic auth rather than object identity for a retained handler: %s",
    async (change) => {
      let handler: (() => Promise<void>) | undefined;
      function HandlerProbe() {
        const authState = usePiOpenaiUsageAuth({
          environmentId,
          instanceId,
          service: "openai",
          onAuthenticated: state.authenticated,
        });
        useLayoutEffect(() => {
          handler = authState.start;
        });
        return null;
      }
      await act(() => root.render(<HandlerProbe />));
      const retainedHandler = handler!;
      state.auth = auth();
      if (change === "unsupported") state.auth = { ...auth(), methods: [] };
      if (change === "active") state.auth = auth("waiting");
      if (change === "wrong-instance") state.auth = auth("idle", otherInstance);
      if (change === "query-failure") state.queryError = "private error";
      state.queryPending = true;
      await act(() => root.render(<HandlerProbe />));
      await act(() => retainedHandler());
      expect(state.start).toHaveBeenCalledTimes(change === "equivalent" ? 1 : 0);
    },
  );
  it("shows a public device code, opens only on user action, and refreshes once on confirmed native persistence", async () => {
    await render();
    await click("Connect OpenAI usage");
    state.auth = auth("waiting");
    await render();
    expect(container.querySelector("code")?.textContent).toBe("ABCD-EFGH");
    expect(state.authenticated).not.toHaveBeenCalled();
    await click("Open OpenAI sign-in page");
    expect(state.open).toHaveBeenCalledExactlyOnceWith("https://auth.openai.com/codex/device");
    state.auth = auth("succeeded");
    await render();
    await render();
    expect(state.authenticated).toHaveBeenCalledTimes(1);
  });
  it("handles confirmation arriving before the start command response", async () => {
    const pending = deferred();
    state.start.mockReturnValue(pending.promise);
    await render();
    await click("Connect OpenAI usage");
    state.auth = auth("succeeded");
    await render();
    expect(state.authenticated).not.toHaveBeenCalled();
    await act(() => pending.resolve(success(auth("waiting"))));
    expect(state.authenticated).toHaveBeenCalledTimes(1);
  });
  it("does not treat an old completed authorization as a new successful attempt", async () => {
    state.auth = auth("succeeded");
    await render();
    expect(state.authenticated).not.toHaveBeenCalled();
  });
  it("rejects retained device codes on subscription failure and recovers only after a successful retry", async () => {
    state.auth = auth("waiting");
    await render();
    expect(container.querySelector("code")?.textContent).toBe("ABCD-EFGH");
    state.queryError = "private backend error";
    await render();
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toContain("Could not read native usage sign-in status.");
    expect(container.textContent).not.toContain("private backend error");
    expect(button("Connect OpenAI usage").disabled).toBe(true);
    await click("Retry status");
    expect(state.refresh).toHaveBeenCalledTimes(1);
    state.queryPending = true;
    await render();
    await click("Retry status");
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(button("Connect OpenAI usage").disabled).toBe(true);
    state.queryError = null;
    state.queryPending = false;
    state.auth = auth();
    await render();
    expect(container.textContent).not.toContain("Could not read native usage sign-in status.");
    await click("Connect OpenAI usage");
    expect(state.start).toHaveBeenCalledTimes(1);
  });
  it("does not report retained success from a failed subscription as confirmation", async () => {
    await render();
    await click("Connect OpenAI usage");
    state.auth = auth("succeeded");
    state.queryError = "private backend error";
    await render();
    expect(state.authenticated).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Subscription sign-in confirmed.");
    state.queryError = null;
    await render();
    expect(state.authenticated).toHaveBeenCalledTimes(1);
  });
  it("does not retry status after the destination permission has been revoked", async () => {
    state.queryError = "private backend error";
    await render();
    state.allowed = false;
    await click("Retry status");
    expect(state.refresh).not.toHaveBeenCalled();
  });
  it.each([
    [
      "This provider does not support sign-in in T3 Code.",
      "This provider does not support sign-in in T3 Code.",
    ],
    [
      "This provider instance is no longer available.",
      "This provider instance is no longer available.",
    ],
    [
      "private SDK error: secret-access-token",
      "Native usage sign-in setup failed on this runtime. Check its Pi installation and retry status.",
    ],
  ])(
    "distinguishes native setup failure %s without exposing credentials",
    async (detail, expected) => {
      state.queryFailure = new ProviderSetupError({ instanceId, operation: "subscribe", detail });
      state.queryError = detail;
      await render();
      expect(container.textContent).toContain(expected);
      expect(container.textContent).not.toContain("Could not read native usage sign-in status.");
      expect(container.textContent).not.toContain("secret-access-token");
      expect(button("Connect OpenAI usage").disabled).toBe(true);
      await click("Connect OpenAI usage");
      expect(state.start).not.toHaveBeenCalled();
      await click("Retry status");
      expect(state.refresh).toHaveBeenCalledTimes(1);
    },
  );
  it("distinguishes destination authorization failures without showing raw error messages", async () => {
    state.queryFailure = new EnvironmentAuthorizationError({
      requiredScope: "providers:manage",
      message: "secret-access-token",
    });
    state.queryError = "secret-access-token";
    await render();
    expect(container.textContent).toContain(
      "requires providers:manage permission on this environment.",
    );
    expect(container.textContent).not.toContain("secret-access-token");
    expect(button("Connect OpenAI usage").disabled).toBe(true);
  });
  it("does not attribute another instance's setup failure to the selected runtime", async () => {
    state.queryFailure = new ProviderSetupError({
      instanceId: otherInstance,
      operation: "subscribe",
      detail: "This provider does not support sign-in in T3 Code.",
    });
    state.queryError = state.queryFailure.message;
    await render();
    expect(container.textContent).toContain("Could not read native usage sign-in status.");
    expect(container.textContent).not.toContain(
      "This provider does not support sign-in in T3 Code.",
    );
  });
  it("reports native setup failures originating in SDK discovery without exposing their details", async () => {
    state.queryFailure = new ProviderSetupError({
      instanceId,
      operation: "discover",
      detail: "SDK discovery failed: secret-access-token",
    });
    state.queryError = state.queryFailure.message;
    await render();
    expect(container.textContent).toContain("Native usage sign-in setup failed on this runtime.");
    expect(container.textContent).not.toContain("secret-access-token");
    expect(button("Connect OpenAI usage").disabled).toBe(true);
  });
  it("cancels the exact active flow without touching direct inference credentials", async () => {
    state.auth = auth("waiting");
    await render();
    await click("Cancel sign-in");
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, flowId: "flow-one" },
    });
    expect(state.authenticated).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });
  it.each(["permission", "read-only", "unsupported", "wrong-service", "query-failure"])(
    "prevents start for %s",
    async (reason) => {
      state.allowed = reason !== "permission";
      if (reason === "unsupported") state.auth = { ...auth(), methods: [] };
      if (reason === "query-failure") state.queryError = "private backend error";
      await render(
        environmentId,
        instanceId,
        reason === "wrong-service" ? "venice" : "openai",
        reason === "read-only",
      );
      button("Connect OpenAI usage")?.click();
      expect(state.start).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("private backend error");
    },
  );
  it.each(["environment", "instance", "service", "permission", "unmount"])(
    "suppresses stale start completion after %s change and cancels only its original flow",
    async (change) => {
      const pending = deferred();
      state.start.mockReturnValue(pending.promise);
      await render();
      await click("Connect OpenAI usage");
      if (change === "unmount") await act(() => root.render(null));
      else {
        if (change === "permission") state.allowed = false;
        state.auth = auth("idle", change === "instance" ? otherInstance : instanceId);
        await render(
          change === "environment" ? otherEnvironment : environmentId,
          change === "instance" ? otherInstance : instanceId,
          change === "service" ? "openai-codex" : "openai",
        );
      }
      await act(() => pending.resolve(success(auth("waiting"))));
      expect(state.authenticated).not.toHaveBeenCalled();
      expect(container.querySelector("code")).toBeNull();
      if (change !== "permission")
        expect(state.cancel).toHaveBeenCalledWith({
          environmentId,
          input: { instanceId, flowId: "flow-one" },
        });
      else expect(state.cancel).not.toHaveBeenCalled();
    },
  );
  it("clears a displayed device code on a target change", async () => {
    state.auth = auth("waiting");
    await render();
    state.auth = auth();
    await render(otherEnvironment);
    expect(container.querySelector("code")).toBeNull();
    state.auth = auth("succeeded");
    await render(otherEnvironment);
    expect(state.authenticated).not.toHaveBeenCalled();
  });
  it("sanitizes command errors and refuses non-OpenAI sign-in URLs", async () => {
    state.start.mockRejectedValue(new Error("secret-access-token"));
    await render();
    await click("Connect OpenAI usage");
    expect(container.textContent).toContain("Could not start");
    expect(container.textContent).not.toContain("secret-access-token");
    state.auth = {
      ...auth("waiting"),
      interaction: {
        type: "deviceCode",
        id: "unsafe",
        url: "https://attacker.example",
        userCode: "CODE",
      },
    };
    await render();
    await click("Open OpenAI sign-in page");
    expect(state.open).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Could not open");
  });
});
