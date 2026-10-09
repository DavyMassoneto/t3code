import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { retainSettingsScope, validateSettingsRouteSearch } from "./settingsScopeNavigation";

vi.mock("./PluginsSettingsPanel", () => ({
  PluginsSettingsPanel: () => null,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environment: null, scope: { kind: "unavailable" } }),
}));

import { Route } from "../../routes/settings.plugins";

function createPluginsRouter(initialEntry: string) {
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
  });
  const plugins = createRoute({
    getParentRoute: () => settings,
    path: "plugins",
    validateSearch: (raw: Record<string, unknown>) => {
      const validate = Route.options.validateSearch;
      if (typeof validate !== "function") throw new Error("Missing Plugins search validator");
      return validate(raw);
    },
  });
  const providers = createRoute({ getParentRoute: () => settings, path: "providers" });
  return createRouter({
    routeTree: root.addChildren([settings.addChildren([plugins, providers])]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("Plugins scope navigation", () => {
  it("maps a legacy environment deep link to the owning machine while retaining the exact Pi runtime", async () => {
    const router = createPluginsRouter(
      "/settings/plugins?environmentId=remote-native&instanceId=pi-work",
    );
    await router.load();
    await router.navigate({
      to: "/settings/plugins",
      search: {
        environmentId: EnvironmentId.make("remote-native"),
        instanceId: ProviderInstanceId.make("pi-work"),
      },
    });
    expect(router.state.location.search).toEqual({
      machine: "remote-native",
      environmentId: "remote-native",
      instanceId: "pi-work",
    });
  });
  it("does not override an explicit settings machine with a legacy environment parameter", async () => {
    const router = createPluginsRouter(
      "/settings/plugins?machine=selected-remote&environmentId=old-link&instanceId=pi-work",
    );
    await router.load();
    expect(router.state.location.search).toEqual({
      machine: "selected-remote",
      environmentId: "old-link",
      instanceId: "pi-work",
    });
  });
  it("retains project, checkout and machine scope across the top-level tabs without carrying a stale runtime id", async () => {
    const router = createPluginsRouter(
      "/settings/plugins?project=repo&machine=remote-native&checkout=remote-native%3Arepo&instanceId=pi-work",
    );
    await router.load();
    await router.navigate({ to: "/settings/providers" });
    expect(router.state.location.search).toEqual({
      project: "repo",
      machine: "remote-native",
      checkout: "remote-native:repo",
    });
    await router.navigate({ to: "/settings/plugins" });
    expect(router.state.location.search).toEqual({
      project: "repo",
      machine: "remote-native",
      checkout: "remote-native:repo",
    });
  });
  it("retains an unavailable explicitly selected machine rather than substituting a local environment", async () => {
    const router = createPluginsRouter(
      "/settings/plugins?machine=missing-remote&instanceId=pi-missing",
    );
    await router.load();
    expect(router.state.location.search).toEqual({
      machine: "missing-remote",
      instanceId: "pi-missing",
    });
    await router.navigate({ to: "/settings/providers" });
    expect(router.state.location.search).toEqual({ machine: "missing-remote" });
  });
  it("does not invent instance or environment ids for untargeted or blank deep links", async () => {
    const router = createPluginsRouter("/settings/plugins?instanceId=%20&environmentId=%20");
    await router.load();
    const validate = Route.options.validateSearch;
    if (typeof validate !== "function") throw new Error("Missing Plugins search validator");
    expect(validate({ instanceId: " ", environmentId: " " })).toEqual({});
    await router.navigate({ to: "/settings/plugins", search: { machine: "remote-native" } });
    expect(router.state.location.search).toEqual({ machine: "remote-native" });
  });
  it("keeps the owning environment from an initially loaded legacy plugin link on category navigation", async () => {
    const router = createPluginsRouter(
      "/settings/plugins?environmentId=remote-native&instanceId=pi-work",
    );
    await router.load();
    await router.navigate({ to: "/settings/providers" });
    expect(router.state.location.search).toEqual({ machine: "remote-native" });
  });
});
