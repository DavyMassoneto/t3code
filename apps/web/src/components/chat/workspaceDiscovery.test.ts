import { PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { shouldRequestWorkspaceDiscovery } from "./workspaceDiscovery";

const key = "environment:pi:/workspace";
const now = Date.parse("2026-10-08T00:01:00.000Z");
const request = {
  force: false,
  inFlight: false,
  hasCurrentSnapshot: false,
  key,
  now,
  lastRequest: null,
  retry: null,
};

describe("workspace discovery", () => {
  it("rescans on explicit picker open after a recent complete empty scan", () => {
    const cached = {
      ...request,
      hasCurrentSnapshot: true,
      lastRequest: { key, requestedAt: now - 60_000 },
    };
    expect(shouldRequestWorkspaceDiscovery(cached)).toBe(false);
    expect(shouldRequestWorkspaceDiscovery({ ...cached, force: true })).toBe(true);
    expect(
      shouldRequestWorkspaceDiscovery({ ...request, hasCurrentSnapshot: true, force: true }),
    ).toBe(true);
  });

  it("coalesces picker opens and prompt changes while a scan is in flight, even beyond TTL", () => {
    const pending = {
      ...request,
      inFlight: true,
      lastRequest: { key, requestedAt: now - PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS },
    };
    expect(shouldRequestWorkspaceDiscovery(pending)).toBe(false);
    expect(shouldRequestWorkspaceDiscovery({ ...pending, force: true })).toBe(false);
    expect(shouldRequestWorkspaceDiscovery({ ...pending, inFlight: false, force: true })).toBe(
      true,
    );
  });

  it("keeps prompt-driven scans throttled after a forced scan, including server clock skew", () => {
    const completed = { ...request, lastRequest: { key, requestedAt: now } };
    expect(shouldRequestWorkspaceDiscovery(completed)).toBe(false);
    expect(
      shouldRequestWorkspaceDiscovery({
        ...completed,
        now: now + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldRequestWorkspaceDiscovery({
        ...completed,
        now: now + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
      }),
    ).toBe(true);
  });

  it("honors failed-scan cooldown for prompt changes but permits explicit retry", () => {
    const failed = { ...request, retry: { key, notBefore: now + 10_000 } };
    expect(shouldRequestWorkspaceDiscovery(failed)).toBe(false);
    expect(shouldRequestWorkspaceDiscovery({ ...failed, force: true })).toBe(true);
    expect(shouldRequestWorkspaceDiscovery({ ...failed, now: now + 10_000 })).toBe(true);
  });

  it("does not throttle a different workspace or provider using the previous scope's request", () => {
    expect(
      shouldRequestWorkspaceDiscovery({
        ...request,
        lastRequest: { key: "environment:other:/other", requestedAt: now },
        retry: { key: "environment:other:/other", notBefore: now + 10_000 },
      }),
    ).toBe(true);
    expect(shouldRequestWorkspaceDiscovery({ ...request, hasCurrentSnapshot: true })).toBe(false);
  });
});
