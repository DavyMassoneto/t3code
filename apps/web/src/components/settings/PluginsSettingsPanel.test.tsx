// @vitest-environment jsdom
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Configuration = Pick<ServerSettings, "providers" | "providerInstances">;
const state = vi.hoisted(() => ({
  environments: new Map<
    EnvironmentId,
    {
      label: string;
      connection: { phase: string };
      serverConfig: { settings: Configuration } | null;
    }
  >(),
  providers: new Map<EnvironmentId, readonly ServerProvider[] | null>(),
  canManage: true,
  subscribed: [] as EnvironmentId[],
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: (environmentId: EnvironmentId) => state.environments.get(environmentId) ?? null,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: (environmentId: EnvironmentId) => {
      state.subscribed.push(environmentId);
      return environmentId;
    },
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (environmentId: EnvironmentId) => state.providers.get(environmentId) ?? null,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canManage }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock("./PiPackagesSettings", () => ({
  PiPackagesSettings: ({
    environmentId,
    instanceId,
  }: {
    environmentId: EnvironmentId;
    instanceId: ProviderInstanceId;
  }) => (
    <div aria-label="Package target" data-environment={environmentId} data-instance={instanceId}>
      Installed fixture
    </div>
  ),
}));

import { PluginsSettingsPanel } from "./PluginsSettingsPanel";

const remote = EnvironmentId.make("remote-native");
const otherRemote = EnvironmentId.make("second-native");
const work = ProviderInstanceId.make("pi-work");
const personal = ProviderInstanceId.make("pi-personal");
function provider(instanceId: ProviderInstanceId, driver = "pi", enabled = true): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId === work ? "Work" : "Personal",
    enabled,
    installed: true,
    version: "0.80.5",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-08T22:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}
function configuration(ids: readonly ProviderInstanceId[] = [work]): Configuration {
  return {
    providers: DEFAULT_UNIFIED_SETTINGS.providers,
    providerInstances: Object.fromEntries(
      ids.map((instanceId) => [
        instanceId,
        { driver: ProviderDriverKind.make("pi"), enabled: true },
      ]),
    ),
  };
}
function environment(settings = configuration()) {
  return { label: "Remote device", connection: { phase: "connected" }, serverConfig: { settings } };
}

describe("Plugins settings environment/runtime ownership", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async (environmentId = remote, instanceId?: ProviderInstanceId) => {
    await act(() =>
      root.render(
        <PluginsSettingsPanel
          destination={{ scope: "global" }}
          environmentId={environmentId}
          {...(instanceId ? { instanceId } : {})}
        />,
      ),
    );
  };
  const packageTarget = () => container.querySelector('[aria-label="Package target"]');
  const select = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Plugin runtime configuration"]');
  const choose = async (instanceId: ProviderInstanceId) => {
    if (select()!.getAttribute("aria-expanded") !== "true") await act(() => select()!.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (entry) => entry.textContent === provider(instanceId).displayName,
    );
    expect(option).toBeDefined();
    await act(() => option!.click());
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.environments = new Map([
      [remote, environment()],
      [otherRemote, environment(configuration([personal]))],
    ]);
    state.providers = new Map([
      [remote, [provider(work)]],
      [otherRemote, [provider(personal)]],
    ]);
    state.canManage = true;
    state.subscribed = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it("passes the actual scoped Pi target unchanged without an unnecessary single-runtime chooser", async () => {
    await render();
    expect(packageTarget()?.getAttribute("data-environment")).toBe(remote);
    expect(packageTarget()?.getAttribute("data-instance")).toBe(work);
    expect(select()).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Plugins");
    expect(state.subscribed).toEqual([remote]);
  });
  it("offers multiple actual enabled Pi configurations and dispatches the chosen instance", async () => {
    state.environments.set(remote, environment(configuration([work, personal])));
    state.providers.set(remote, [
      provider(work),
      provider(personal),
      provider(ProviderInstanceId.make("other-driver"), "codex"),
    ]);
    await render();
    expect(select()!.textContent).toContain("Work");
    expect(select()!.textContent).not.toContain(work);
    await act(() => select()!.click());
    expect(
      Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent),
    ).toEqual(["Work", "Personal"]);
    await choose(personal);
    expect(packageTarget()?.getAttribute("data-instance")).toBe(personal);
    expect(packageTarget()?.getAttribute("data-environment")).toBe(remote);
  });
  it("honors an explicit actual native runtime target", async () => {
    state.environments.set(remote, environment(configuration([work, personal])));
    state.providers.set(remote, [provider(work), provider(personal)]);
    await render(remote, personal);
    expect(packageTarget()?.getAttribute("data-instance")).toBe(personal);
  });
  it("does not silently substitute another runtime for a missing or disabled explicit target", async () => {
    await render(remote, personal);
    expect(packageTarget()).toBeNull();
    expect(container.textContent).toContain("unavailable or disabled");
    expect(select()).not.toBeNull();
    await choose(work);
    expect(packageTarget()?.getAttribute("data-instance")).toBe(work);
  });
  it("does not fabricate a default Pi instance while discovery is loading or empty", async () => {
    state.providers.set(remote, null);
    await render();
    expect(container.textContent).toContain("Loading plugin runtimes");
    expect(packageTarget()).toBeNull();
    state.providers.set(remote, []);
    await render();
    expect(container.textContent).toContain("No enabled Pi runtime");
    expect(packageTarget()).toBeNull();
  });
  it("excludes a stale custom runtime removed from the environment's settings", async () => {
    state.environments.set(remote, environment(configuration([])));
    await render();
    expect(packageTarget()).toBeNull();
    expect(container.textContent).toContain("No enabled Pi runtime");
  });
  it("keeps requested runtime identity scoped to its owning environment", async () => {
    await render(remote, work);
    await render(otherRemote);
    expect(packageTarget()?.getAttribute("data-instance")).toBe(personal);
    expect(packageTarget()?.getAttribute("data-environment")).toBe(otherRemote);
    expect(state.subscribed).toEqual([remote, otherRemote]);
  });
  it("does not reuse an old environment's identical instance id", async () => {
    state.environments.set(otherRemote, environment(configuration([work])));
    state.providers.set(otherRemote, [provider(work)]);
    await render(remote, work);
    await render(otherRemote, work);
    expect(packageTarget()?.getAttribute("data-environment")).toBe(otherRemote);
    expect(packageTarget()?.getAttribute("data-instance")).toBe(work);
  });
  it.each(["disconnected", "error", "connecting"])(
    "does not mount package commands while %s even with cached config",
    async (phase) => {
      state.environments.set(remote, { ...environment(), connection: { phase } });
      await render();
      expect(container.textContent).toContain("Reconnect Remote device");
      expect(packageTarget()).toBeNull();
      expect(state.subscribed).toEqual([]);
    },
  );
  it("does not mount package commands for a missing environment or config", async () => {
    state.environments.delete(remote);
    await render();
    expect(packageTarget()).toBeNull();
    state.environments.set(remote, { ...environment(), serverConfig: null });
    await render();
    expect(container.textContent).toContain("Loading this environment's configuration");
    expect(state.subscribed).toEqual([]);
  });
  it("retains the page and runtime selection when package commands lack permission", async () => {
    state.canManage = false;
    await render();
    expect(container.textContent).toContain("providers:manage permission");
    expect(packageTarget()?.getAttribute("data-instance")).toBe(work);
  });
  it("stops targeting a selected runtime when settings disable it without stopping other configurations", async () => {
    state.environments.set(remote, environment(configuration([work, personal])));
    state.providers.set(remote, [provider(work), provider(personal)]);
    await render(remote, personal);
    state.environments.set(remote, environment(configuration([work])));
    await render(remote, personal);
    expect(packageTarget()).toBeNull();
    await choose(work);
    expect(packageTarget()?.getAttribute("data-instance")).toBe(work);
  });
});
