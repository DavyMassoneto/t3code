import {
  EnvironmentId,
  ProviderInstanceId,
  type PiConnection,
  type PiProviderLimits as NativeLimits,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ allowed: true, list: vi.fn() }));
vi.mock("../settings/PiOpenaiUsageAuth", () => ({
  PiOpenaiUsageAuth: ({ onAuthenticated }: { onAuthenticated: () => void }) => (
    <button onClick={onAuthenticated}>Connect OpenAI usage fixture</button>
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/piConnections", () => ({
  listPiConnections: { permissionAtom: () => "permission" },
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => state.allowed }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.list }));

import { PiProviderLimits } from "./PiProviderLimits";
import {
  formatNativeMetricValue,
  groupPiProviderLimits,
  nativeMetricKind,
} from "./piProviderLimitsHelpers";

const first = EnvironmentId.make("remote-first");
const second = EnvironmentId.make("remote-second");
const instanceId = ProviderInstanceId.make("pi-work");
const otherInstance = ProviderInstanceId.make("pi-personal");
const checkedAt = "2026-10-08T10:00:00Z";
function connection(
  service: string,
  status: NativeLimits["status"],
  metrics: NativeLimits["metrics"] = [],
): PiConnection {
  return {
    service,
    name: service,
    configured: true,
    authentication: "managed-in-pi",
    authMethods: ["api_key"],
    limits: "unavailable",
    models: [],
    limitsDetails: { status, checkedAt, source: "native fixture", metrics },
  };
}
function success(connections: readonly PiConnection[], selectedInstance = instanceId) {
  return { _tag: "Success" as const, value: { instanceId: selectedInstance, connections } };
}
function deferred() {
  let resolve!: (result: ReturnType<typeof success>) => void;
  const promise = new Promise<ReturnType<typeof success>>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("native provider limits", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async (environmentId = first, selectedInstance = instanceId, refreshToken = 0) => {
    await act(() =>
      root.render(
        <PiProviderLimits
          environmentId={environmentId}
          instanceId={selectedInstance}
          contextLabel="Remote · Work Pi"
          refreshToken={refreshToken}
        />,
      ),
    );
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = true;
    state.list.mockReset();
    state.list.mockResolvedValue(success([]));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  it("exposes separate OpenAI quota authorization outside unsupported details and refreshes limits on confirmation", async () => {
    state.list.mockResolvedValue(success([connection("openai", "unsupported")]));
    await render();
    const connect = container.querySelector("button")!;
    expect(connect.textContent).toBe("Connect OpenAI usage fixture");
    expect(connect.closest("details")).toBeNull();
    await act(() => connect.click());
    expect(state.list).toHaveBeenCalledTimes(2);
    expect(state.list).toHaveBeenLastCalledWith({
      environmentId: first,
      input: { instanceId, includeLimits: true },
    });
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads native metrics initially using the guarded explicit environment and instance", async () => {
    state.list.mockResolvedValue(
      success([
        connection("Anthropic", "available", [
          {
            id: "requests",
            label: "Requests per minute",
            unit: "requests",
            used: 0,
            limit: 60,
            remaining: 60,
            windowSeconds: 60,
            resetsAt: "2026-10-08T10:01:00Z",
          },
          {
            id: "tokens",
            label: "Tokens per minute",
            unit: "tokens",
            model: "claude-sonnet",
            used: 300,
            limit: 300,
            remaining: 0,
            windowSeconds: 60,
          },
          {
            id: "session",
            label: "Five-hour subscription window",
            unit: "percent",
            used: 0,
            limit: 100,
            remaining: 100,
            windowSeconds: 18000,
            resetsAt: "2026-10-08T15:00:00Z",
          },
          {
            id: "weekly",
            label: "Weekly subscription window",
            unit: "percent",
            used: 100,
            limit: 100,
            remaining: 0,
            windowSeconds: 604800,
          },
        ]),
        connection("Venice", "available", [
          { id: "balance", label: "USD balance", unit: "USD", remaining: 0 },
          { id: "diem", label: "Diem balance", unit: "Diem", remaining: 12.5 },
          {
            id: "empty",
            label: "Empty allocation",
            unit: "credits",
            used: 0,
            limit: 0,
            remaining: 0,
          },
        ]),
      ]),
    );
    await render();
    expect(state.list).toHaveBeenCalledExactlyOnceWith({
      environmentId: first,
      input: { instanceId, includeLimits: true },
    });
    expect(container.textContent).not.toContain("Requests per minute");
    expect(container.textContent).not.toContain("Tokens per minute");
    expect(container.textContent).toContain(formatNativeMetricValue(0, "USD"));
    expect(container.textContent).toContain(`${(12.5).toLocaleString()} Diem`);
    expect(container.textContent).not.toContain("Rate limit");
    expect(container.textContent).not.toContain("claude-sonnet");
    expect(container.textContent).toContain("0% used");
    expect(container.textContent).toContain("100% used");
    expect(container.querySelector('time[datetime="2026-10-08T15:00:00Z"]')).not.toBeNull();
    expect(container.querySelectorAll('[aria-label="Venice balances"]')).toHaveLength(1);
    expect(container.textContent).toContain("Source: native fixture");
    expect(container.querySelector(`time[datetime="${checkedAt}"]`)).not.toBeNull();
    expect(container.querySelectorAll("meter")).toHaveLength(2);
    expect(container.querySelector('[aria-label="Venice limits"] meter')).toBeNull();
    expect(container.textContent).not.toContain("Subscription quota unavailable");
  });

  it("keeps local not-applicable services quiet and summarizes unsupported services without cards", async () => {
    const fixtures = [
      connection("Local llama", "not_applicable"),
      connection("Extension", "unsupported"),
      connection("Custom", "unsupported"),
    ];
    state.list.mockResolvedValue(success(fixtures));
    await render();
    expect(container.textContent).not.toContain("Local llama");
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(container.querySelector("summary")?.textContent).toContain(
      "2 services did not report balances or subscription usage",
    );
    expect(container.querySelector("summary")?.textContent).not.toContain("Extension");
    expect(container.querySelector('[aria-label="Extension limits"]')).toBeNull();
    state.list.mockResolvedValue(success([fixtures[0]!]));
    await render(first, instanceId, 1);
    expect(container.textContent).toBe("");
  });

  it("consolidates zero and negative balances with compact locale precision and exact accessible values", async () => {
    const negative = -11.65049819;
    state.list.mockResolvedValue(
      success([
        connection("Venice", "available", [
          { id: "usd", label: "USD balance", unit: "USD", remaining: negative },
          { id: "diem", label: "Diem balance", unit: "DIEM", remaining: 0 },
          { id: "credit", label: "Bundled credit balance", unit: "USD", remaining: 11.65049819 },
          { id: "capacity", label: "RPM", unit: "requests", limit: 1000, model: "technical-model" },
        ]),
      ]),
    );
    await render();
    const balances = container.querySelector('[aria-label="Venice balances"]')!;
    expect(balances.querySelectorAll("dd")).toHaveLength(3);
    const compact = negative.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const exact = negative.toLocaleString(undefined, { maximumFractionDigits: 20 });
    const balance = balances.querySelector("dd")!;
    expect(balance.textContent).toBe(`${compact} USD`);
    expect(balance.getAttribute("title")).toBe(`${exact} USD`);
    expect(balance.getAttribute("aria-label")).toContain(`${exact} USD`);
    expect(container.textContent).toContain("0 DIEM");
    expect(container.textContent).not.toContain("RPM");
    expect(container.textContent).not.toContain("technical-model");
    expect(container.querySelectorAll("meter")).toHaveLength(0);
  });

  it("never renders model RPM, TPM or RPD capacity lists as usage quotas", async () => {
    state.list.mockResolvedValue(
      success([
        connection(
          "Venice",
          "available",
          Array.from({ length: 90 }, (_, index) => ({
            id: `rate-${index}`,
            label: ["RPM", "TPM", "RPD"][index % 3]!,
            unit: index % 3 === 1 ? "tokens" : "requests",
            limit: 10000,
            model: `technical-model-${index}`,
            windowSeconds: 86400,
          })),
        ),
      ]),
    );
    await render();
    expect(container.querySelector('[aria-label="Venice limits"]')).toBeNull();
    expect(container.querySelectorAll("meter")).toHaveLength(0);
    expect(container.textContent).not.toContain("technical-model");
    expect(container.textContent).not.toContain("10000");
    expect(container.querySelector("summary")?.textContent).toContain(
      "1 service did not report balances or subscription usage",
    );
  });

  it("shows a reported remaining-only quota without fabricating used or missing remaining amounts", async () => {
    state.list.mockResolvedValue(
      success([
        connection("OpenAI", "available", [
          {
            id: "primary",
            label: "Primary subscription window",
            unit: "percent",
            used: 35,
            limit: 100,
            resetsAt: "2026-10-08T15:00:00Z",
          },
          {
            id: "secondary",
            label: "Secondary subscription window",
            unit: "percent",
            remaining: 0,
            limit: 100,
            windowSeconds: 604800,
          },
        ]),
      ]),
    );
    await render();
    const used = container.querySelector(
      'meter[aria-label="Primary subscription window: 35% used"]',
    )!;
    const remaining = container.querySelector(
      'meter[aria-label="Secondary subscription window: 0% left"]',
    )!;
    expect(used.getAttribute("value")).toBe("35");
    expect(used.getAttribute("title")).not.toContain("remaining:");
    expect(remaining.getAttribute("value")).toBe("0");
    expect(remaining.getAttribute("title")).not.toContain("used:");
    expect(container.querySelector('[aria-label="OpenAI limits"]')).not.toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });

  it("distinguishes service errors from unsupported capabilities and leaves metadata as plain text", async () => {
    const failed = connection("OpenAI", "error");
    state.list.mockResolvedValue(
      success([
        {
          ...failed,
          limitsDetails: {
            ...failed.limitsDetails!,
            source: "https://untrusted.invalid",
            message: "Temporary upstream failure https://untrusted.invalid/retry",
          },
        },
      ]),
    );
    await render();
    expect(container.textContent).toContain("limits could not be checked. Retry with Refresh.");
    expect(container.textContent).toContain("Temporary upstream failure");
    expect(container.textContent).not.toContain("not supported");
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("reports transport failures separately and supports explicit refresh without polling", async () => {
    state.list.mockResolvedValueOnce({ _tag: "Failure", cause: {} });
    await render();
    expect(container.textContent).toContain("This request failed");
    state.list.mockResolvedValue(
      success([
        connection("Venice", "available", [
          { id: "balance", label: "Balance", unit: "USD", remaining: 7 },
        ]),
      ]),
    );
    await render(first, instanceId, 1);
    expect(container.textContent).toContain(formatNativeMetricValue(7, "USD"));
    await render(first, instanceId, 1);
    expect(state.list).toHaveBeenCalledTimes(2);
  });

  it.each(["environment", "instance", "refresh"] as const)(
    "discards old responses after a %s switch",
    async (change) => {
      const old = deferred();
      const next = deferred();
      state.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      await render();
      const environment = change === "environment" ? second : first;
      const instance = change === "instance" ? otherInstance : instanceId;
      await render(environment, instance, change === "refresh" ? 1 : 0);
      await act(() =>
        next.resolve(success([connection("Current service", "unsupported")], instance)),
      );
      await act(() => old.resolve(success([connection("Stale service", "unsupported")])));
      expect(container.textContent).toContain("Current service");
      expect(container.textContent).not.toContain("Stale service");
      expect(state.list).toHaveBeenLastCalledWith({
        environmentId: environment,
        input: { instanceId: instance, includeLimits: true },
      });
    },
  );

  it("does not request without permission, and drops a response after permission loss", async () => {
    state.allowed = false;
    await render();
    expect(state.list).not.toHaveBeenCalled();
    expect(container.textContent).toContain("providers:manage");
    state.allowed = true;
    const pending = deferred();
    state.list.mockReturnValueOnce(pending.promise);
    await render();
    state.allowed = false;
    await render();
    await act(() => pending.resolve(success([connection("Denied service", "unsupported")])));
    expect(container.textContent).not.toContain("Denied service");
    state.allowed = true;
    await render();
    expect(container.textContent).not.toContain("Denied service");
    expect(state.list).toHaveBeenCalledTimes(2);
  });

  it("rechecks permission at completion even before the permission atom rerenders", async () => {
    const pending = deferred();
    state.list.mockReturnValueOnce(pending.promise);
    await render();
    state.allowed = false;
    await act(() => pending.resolve(success([connection("Revoked service", "unsupported")])));
    expect(container.textContent).not.toContain("Revoked service");
  });

  it("ignores responses after unmount and rejects mismatched instances", async () => {
    const pending = deferred();
    state.list.mockReturnValueOnce(pending.promise);
    await render();
    await act(() => root.render(null));
    await act(() => pending.resolve(success([connection("Abandoned service", "unsupported")])));
    expect(container.textContent).toBe("");
    state.list.mockResolvedValue(
      success([connection("Wrong instance", "unsupported")], otherInstance),
    );
    await render();
    expect(container.textContent).toContain("This request failed");
    expect(container.textContent).not.toContain("Wrong instance");
  });

  it("does not reinterpret balances or generic windows as subscription quotas", () => {
    expect(
      nativeMetricKind({ id: "metric1", label: "Extension metric1", unit: "DIEM", remaining: 0 }),
    ).toBe("Balance");
    expect(nativeMetricKind({ id: "rpm", label: "RPM", unit: "requests" })).toBe("Rate limit");
    expect(nativeMetricKind({ id: "balance", label: "Balance", unit: "Diem" })).toBe("Balance");
    expect(
      nativeMetricKind({
        id: "weekly",
        label: "Weekly usage",
        unit: "percent",
        windowSeconds: 604800,
      }),
    ).toBe("Usage window");
    expect(
      nativeMetricKind({ id: "subscription", label: "Subscription quota", unit: "percent" }),
    ).toBe("Subscription quota");
    const legacy: PiConnection = {
      service: "old-extension",
      name: "Old extension",
      configured: true,
      authMethods: ["api_key"],
      authentication: "managed-in-pi",
      limits: "unavailable",
      models: [],
    };
    expect(groupPiProviderLimits([legacy]).unsupported).toHaveLength(1);
  });
});

// @vitest-environment jsdom
