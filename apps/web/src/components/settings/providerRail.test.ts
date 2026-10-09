import { EnvironmentId, ProviderInstanceId, type PiConnection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildNativeProviderRail,
  resolveNativeProviderSelection,
  filterNativeProviderCatalog,
  mergeNativeServiceValues,
} from "./providerRail";

const environmentId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("pi-work");
const connections: readonly PiConnection[] = [
  "anthropic",
  "openai",
  "pi-claude",
  "venice",
  "private-new-service",
].map<PiConnection>((service) => ({
  service,
  name: service,
  configured: service === "anthropic",
  authMethods: ["api_key"],
  authentication: "managed-in-pi",
  limits: "unavailable",
  models: [],
}));

describe("native provider rail", () => {
  it("retains only configured services and the explicitly selected configuration with true runtime identity", () => {
    expect(
      buildNativeProviderRail(environmentId, instanceId, connections).map((entry) => entry.service),
    ).toEqual(["anthropic"]);
    const entries = buildNativeProviderRail(environmentId, instanceId, connections, "pi-claude");
    expect(entries.map((entry) => entry.service)).toEqual(["anthropic", "pi-claude"]);
    for (const entry of entries) {
      expect(entry.environmentId).toBe(environmentId);
      expect(entry.instanceId).toBe(instanceId);
      expect(entry.connection).toBe(
        connections.find((connection) => connection.service === entry.service),
      );
    }
    expect(resolveNativeProviderSelection(entries, "pi-claude")?.instanceId).toBe(instanceId);
    expect(resolveNativeProviderSelection(entries, "private-new-service")?.service).toBe(
      "anthropic",
    );
  });

  it("selects within the current runtime catalog and clears removed services", () => {
    const entries = buildNativeProviderRail(environmentId, instanceId, connections);
    expect(resolveNativeProviderSelection(entries, null)?.service).toBe("anthropic");
    const otherEntries = buildNativeProviderRail(
      EnvironmentId.make("other"),
      ProviderInstanceId.make("pi-other"),
      connections.slice(1, 2),
      "openai",
    );
    expect(resolveNativeProviderSelection(otherEntries, "anthropic")).toBe(otherEntries[0]);
    expect(resolveNativeProviderSelection([], "anthropic")).toBeNull();
  });
  it("searches disconnected services by native name and service id", () => {
    expect(filterNativeProviderCatalog(connections, " ANTHROPIC ")).toEqual([]);
    expect(
      filterNativeProviderCatalog(connections, "PRIVATE-new").map(
        (connection) => connection.service,
      ),
    ).toEqual(["private-new-service"]);
    expect(filterNativeProviderCatalog(connections, "")).toHaveLength(4);
  });
  it("merges service-local model preferences without changing other services", () => {
    expect(
      mergeNativeServiceValues(
        ["openai/model", "anthropic/old", "private/model"],
        ["anthropic/new", "openai/unrelated"],
        "anthropic",
      ),
    ).toEqual(["openai/model", "private/model", "anthropic/new"]);
    expect(
      mergeNativeServiceValues(["openai/model", "unprefixed"], [], "anthropic", ["unprefixed"]),
    ).toEqual(["openai/model"]);
  });
});
