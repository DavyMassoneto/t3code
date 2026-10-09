import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type PiConnection,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Redacted from "effect/Redacted";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { getAppModelOptionsForInstance } from "../../modelSelection";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  credentialsPermission: Symbol.for("test-pi-credentials-permission"),
  saveCredentials: { permissionAtom: () => Symbol.for("test-pi-credentials-permission") },
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
  uninstallAcpRegistryManagedBinary: Symbol("uninstallAcpRegistryManagedBinary"),
  acceptAcpRegistryUrlAuth: Symbol("acceptAcpRegistryUrlAuth"),
}));

const commands = vi.hoisted(() => ({
  nativeRefresh: vi.fn(),
  saveCredentials: vi.fn(),
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  canManageProviders: true,
  canWriteSettings: true,
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  mutationEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
  mutateProviderInstance: vi.fn(),
  updateClientSettings: vi.fn(),
}));

const settingsSearchState = vi.hoisted(() => ({
  targetId: null as string | null,
  effects: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => settingsSearchState.effects.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("./settingsLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsLayout")>();
  return {
    ...actual,
    useSettingsSearchTargetId: () => settingsSearchState.targetId,
  };
});

vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === atoms.providersAtom
      ? atoms.providers
      : atom === atoms.credentialsPermission
        ? commands.canManageProviders
        : false,
}));

vi.mock("../../state/piConnectionCredentials", () => ({
  setPiConnectionApiKey: atoms.saveCredentials,
}));

vi.mock("./PiConnectionsPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./PiConnectionsPanel")>();
  return {
    ...actual,
    usePiConnections: (environmentId: EnvironmentId, instanceId: ProviderInstanceId | null) => ({
      canManage: commands.canManageProviders,
      busy: false,
      failed: false,
      refresh: commands.nativeRefresh,
      result:
        instanceId && commands.canManageProviders && environmentId === "remote-device"
          ? {
              instanceId,
              connections: nativeConnections.map((connection) => ({
                ...connection,
                name: instanceId === "pi" ? connection.name : `${connection.name} work`,
              })),
            }
          : null,
    }),
  };
});

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
    updateProvider: atoms.updateProvider,
    uninstallAcpRegistryManagedBinary: atoms.uninstallAcpRegistryManagedBinary,
    acceptAcpRegistryUrlAuth: atoms.acceptAcpRegistryUrlAuth,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: unknown) =>
    atom === atoms.saveCredentials
      ? commands.saveCredentials
      : atom === atoms.refreshProviders
        ? commands.refresh
        : atom === atoms.uninstallAcpRegistryManagedBinary
          ? commands.uninstall
          : atom === atoms.acceptAcpRegistryUrlAuth
            ? commands.acceptUrlAuth
            : commands.updateProvider,
}));

vi.mock("../../hooks/useSettings", () => ({
  useUpdateClientSettings: () => settingsState.updateClientSettings,
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.updateEnvironmentIds.push(environmentId);
    return settingsState.updateSettings;
  },
  usePersistEnvironmentProviderInstanceMutation: (environmentId: EnvironmentId) => {
    settingsState.mutationEnvironmentIds.push(environmentId);
    return settingsState.mutateProviderInstance;
  },
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
  useEnvironmentScope: (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" &&
    (scope === "providers:manage"
      ? commands.canManageProviders
      : scope === "settings:write"
        ? commands.canWriteSettings
        : scope === "orchestration:read"),
  readEnvironmentScope: (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" &&
    (scope === "providers:manage"
      ? commands.canManageProviders
      : scope === "settings:write"
        ? commands.canWriteSettings
        : scope === "orchestration:read"),
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => [],
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";
import { PiConnectionDetails, PiConnectionCredentialsForm } from "./PiConnectionsPanel";
import { PiPackagesSettings } from "./PiPackagesSettings";
import { PiOpenaiUsageAuth } from "./PiOpenaiUsageAuth";
import { PiProviderLimits } from "../usage/PiProviderLimits";
import { ProviderModelsSection } from "./ProviderModelsSection";

const nativeConnections: readonly PiConnection[] = [
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["pi-claude", "Pi Claude"],
  ["venice", "Venice"],
  ["custom", "Private service"],
].map<PiConnection>(([service, name]) => ({
  service: service!,
  name: name!,
  configured: service === "anthropic",
  authMethods: ["api_key"],
  authentication: "managed-in-pi",
  limits: "unavailable",
  authSource: "environment",
  models: [{ slug: `${service}/model`, name: `${name} model`, available: true }],
}));

function selectRuntime(panel: ReturnType<typeof renderPanel>, instanceId: ProviderInstanceId) {
  const selector = visitElements(
    panel,
    (element) => element.props["aria-label"] === "Runtime configuration",
  );
  if (!selector) throw new Error("Missing runtime selector");
  (selector.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: instanceId },
  });
}

const environmentId = EnvironmentId.make("remote-device");
const piId = ProviderInstanceId.make("pi");
const customId = ProviderInstanceId.make("pi_work");

function provider(): ServerProvider {
  return {
    instanceId: piId,
    driver: ProviderDriverKind.make("pi"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

function renderPanel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options?.targetInstanceId === undefined
      ? {}
      : { targetInstanceId: options.targetInstanceId }),
  }) as ReactElement<Record<string, unknown>>;
}

function isRefreshButton(element: ReactElement<Record<string, unknown>>): boolean {
  const children = element.props.children;
  return (
    Array.isArray(children) &&
    children.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        (child as ReactElement<Record<string, unknown>>).props?.className === "sr-only" &&
        (child as ReactElement<Record<string, unknown>>).props?.children ===
          "Refresh provider status",
    )
  );
}

function isAddProviderButton(element: ReactElement<Record<string, unknown>>): boolean {
  return element.props["aria-label"] === "Add provider";
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.readEnvironmentIds = [];
    settingsState.updateEnvironmentIds = [];
    settingsState.mutationEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    settingsState.updateClientSettings.mockReset();
    settingsSearchState.targetId = null;
    settingsSearchState.effects = [];
    settingsState.mutateProviderInstance
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: {} });
    commands.canManageProviders = true;
    commands.nativeRefresh.mockReset().mockResolvedValue(undefined);
    commands.saveCredentials.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { instanceId: piId, service: "anthropic", configured: true },
    });
    commands.canWriteSettings = true;
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.uninstall.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    commands.acceptUrlAuth
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { accepted: true } });
  });

  it("places native services in the main rail, not the Pi runtime", () => {
    const panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props.instanceId === "pi" && element.props.mode === "list",
      ),
    ).toBeNull();
    const rail = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Native providers",
    );
    expect(rail).not.toBeNull();
    for (const connection of nativeConnections) {
      if (connection.configured) expect(JSON.stringify(rail)).toContain(connection.name);
      else expect(JSON.stringify(rail)).not.toContain(connection.name);
    }
    expect(
      visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
    ).toBe(piId);
    expect(visitElements(panel, (element) => element.type === PiPackagesSettings)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Runtime configuration"),
    ).toBeNull();
    const advanced = visitElements(panel, (element) => element.props.title === "Advanced");
    const runtimeDisclosure = visitElements(advanced, (element) => element.type === "details");
    expect(
      visitElements(runtimeDisclosure, (element) => element.type === PiPackagesSettings),
    ).toBeNull();
    expect(visitElements(advanced, (element) => element.type === PiPackagesSettings)).toBeNull();
    const plugins = visitElements(panel, (element) => element.props.title === "Plugins");
    expect(plugins).toBeNull();
    expect(
      visitElements(advanced, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();
    for (const driver of [
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
    ] as const) {
      expect(
        visitElements(
          panel,
          (element) => element.props.instanceId === driver && element.props.mode === "list",
        ),
      ).toBeNull();
    }
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
  });

  it("selects a discovered native service independently from its runtime configuration", () => {
    let panel = renderPanel();
    const add = visitElements(panel, isAddProviderButton);
    if (!add) throw new Error("Missing Add provider");
    (add.props.onClick as () => void)();
    panel = renderPanel();
    const search = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Search native providers",
    );
    if (!search) throw new Error("Missing native provider search");
    (search.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Private" },
    });
    panel = renderPanel();
    const catalog = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Available native providers",
    );
    expect(JSON.stringify(catalog)).not.toContain("OpenAI");
    const candidate = visitElements(
      catalog,
      (element) =>
        typeof element.props.onClick === "function" &&
        JSON.stringify(element.props.children).includes("Private service"),
    );
    if (!candidate) throw new Error("Missing custom service in chooser");
    (candidate.props.onClick as () => void)();
    panel = renderPanel();
    const rail = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Native providers",
    );
    const customService = visitElements(
      rail,
      (element) =>
        element.type === "button" &&
        JSON.stringify(element.props.children).includes("Private service"),
    );
    if (!customService) throw new Error("Missing custom native service while configuring");
    (customService.props.onClick as () => void)();
    panel = renderPanel();
    const details = visitElements(panel, (element) => element.type === PiConnectionDetails);
    expect(details?.props.connection).toEqual(nativeConnections[4]);
    expect(JSON.stringify(rail)).toContain("credentials required");
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
    expect(
      visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
    ).toBe(piId);
    const cancel = visitElements(
      panel,
      (element) => element.props.children === "Cancel configuration",
    );
    if (!cancel) throw new Error("Missing cancel configuration");
    (cancel.props.onClick as () => void)();
    panel = renderPanel();
    expect(
      JSON.stringify(
        visitElements(panel, (element) => element.props["aria-label"] === "Native providers"),
      ),
    ).not.toContain("Private service");
  });

  it("exposes separate OpenAI usage authorization for the selected native service without querying quotas during navigation", () => {
    let panel = renderPanel();
    const add = visitElements(panel, isAddProviderButton);
    if (!add) throw new Error("Missing Add provider");
    (add.props.onClick as () => void)();
    panel = renderPanel();
    const catalog = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Available native providers",
    );
    const candidate = visitElements(
      catalog,
      (element) =>
        typeof element.props.onClick === "function" &&
        JSON.stringify(element.props.children).includes("OpenAI"),
    );
    if (!candidate) throw new Error("Missing native OpenAI candidate");
    (candidate.props.onClick as () => void)();
    panel = renderPanel();
    const authorization = visitElements(panel, (element) => element.type === PiOpenaiUsageAuth);
    expect(authorization?.props.environmentId).toBe(environmentId);
    expect(authorization?.props.instanceId).toBe(piId);
    expect(authorization?.props.service).toBe("openai");
    expect(visitElements(panel, (element) => element.type === PiProviderLimits)).toBeNull();
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
    if (!authorization) throw new Error("Missing selected OpenAI usage authorization");
    (authorization.props.onAuthenticated as () => void)();
    panel = renderPanel();
    const limits = visitElements(panel, (element) => element.type === PiProviderLimits);
    expect(limits?.props.environmentId).toBe(environmentId);
    expect(limits?.props.instanceId).toBe(piId);
    expect(limits?.props.service).toBe("openai");
    expect(limits?.props.refreshToken).toBe(1);
  });

  it("hides native discovery when the provider management grant is missing", () => {
    commands.canManageProviders = false;
    const panel = renderPanel({ readOnly: true });
    expect(visitElements(panel, (element) => element.type === PiConnectionDetails)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
    ).toBe(piId);
    const refreshConnections = visitElements(
      panel,
      (element) => element.props.children === "Refresh connections",
    );
    expect(refreshConnections?.props.disabled).toBe(true);
  });

  it.each([
    ["onHiddenModelsChange", "hiddenModels"],
    ["onModelOrderChange", "modelOrder"],
  ])(
    "merges selected service %s without changing another service or runtime",
    (action, preference) => {
      settingsState.value = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: {
          [piId]: { hiddenModels: ["openai/model"], modelOrder: ["openai/model"] },
          [customId]: { hiddenModels: ["venice/model"], modelOrder: ["venice/model"] },
        },
      };
      const panel = renderPanel();
      const details = visitElements(panel, (element) => element.type === PiConnectionDetails);
      const editor = visitElements(details, (element) => element.type === ProviderModelsSection);
      if (!editor) throw new Error("Missing selected service model editor");
      expect((editor.props.models as { slug: string }[]).map((model) => model.slug)).toEqual([
        "anthropic/model",
      ]);
      (editor.props[action] as (models: string[]) => void)(["anthropic/model"]);
      expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith({
        providerModelPreferences: {
          [piId]: {
            hiddenModels: ["openai/model"],
            modelOrder: ["openai/model"],
            [preference]: ["openai/model", "anthropic/model"],
          },
          [customId]: { hiddenModels: ["venice/model"], modelOrder: ["venice/model"] },
        },
      });
      expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
    },
  );

  it("preserves other service and runtime favorites when the selected service changes favorites", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      favorites: [
        { provider: piId, model: "openai/model" },
        { provider: customId, model: "venice/model" },
      ],
    };
    const panel = renderPanel();
    const editor = visitElements(
      visitElements(panel, (element) => element.type === PiConnectionDetails),
      (element) => element.type === ProviderModelsSection,
    );
    if (!editor) throw new Error("Missing native model editor");
    (editor.props.onFavoriteModelsChange as (models: string[]) => void)(["anthropic/model"]);
    expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith({
      favorites: [
        { provider: customId, model: "venice/model" },
        { provider: piId, model: "openai/model" },
        { provider: piId, model: "anthropic/model" },
      ],
    });
  });

  it("disables a service through picker filters without stopping Pi or changing credentials", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerModelPreferences: {
        [piId]: { hiddenModels: ["openai/model"], modelOrder: ["openai/model"] },
      },
    };
    const panel = renderPanel();
    const toggle = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Show Anthropic models in picker",
    );
    if (!toggle) throw new Error("Missing service model visibility control");
    expect(toggle.props.checked).toBe(true);
    (toggle.props.onCheckedChange as (checked: boolean) => void)(false);
    expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith({
      providerModelPreferences: {
        [piId]: { hiddenModels: ["openai/model", "anthropic/model"], modelOrder: ["openai/model"] },
      },
    });
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("service disable and enable reaches the real Pi picker for both native and custom models", () => {
    const snapshot: ServerProvider = {
      ...provider(),
      models: [
        { slug: "anthropic/model", name: "Anthropic model", isCustom: false, capabilities: null },
        { slug: "anthropic/custom", name: "Anthropic custom", isCustom: true, capabilities: null },
        { slug: "openai/custom", name: "OpenAI custom", isCustom: true, capabilities: null },
      ],
    };
    atoms.providers = [snapshot];
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [piId]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
          config: { customModels: ["anthropic/custom", "openai/custom"] },
        },
      },
      providerModelPreferences: { [piId]: { hiddenModels: ["venice/custom"], modelOrder: [] } },
    };
    let panel = renderPanel();
    const disable = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Show Anthropic models in picker",
    );
    if (!disable) throw new Error("Missing native service visibility switch");
    (disable.props.onCheckedChange as (checked: boolean) => void)(false);
    const disabledPatch = settingsState.updateClientSettings.mock.lastCall?.[0];
    expect(disabledPatch).toEqual({
      providerModelPreferences: {
        [piId]: {
          hiddenModels: ["venice/custom", "anthropic/model", "anthropic/custom"],
          modelOrder: [],
        },
      },
    });
    const disabledSettings: UnifiedSettings = { ...settingsState.value, ...disabledPatch };
    settingsState.value = disabledSettings;
    const entry = deriveProviderInstanceEntries([snapshot])[0]!;
    expect(
      getAppModelOptionsForInstance(disabledSettings, entry).map((model) => model.slug),
    ).toEqual(["openai/custom"]);
    panel = renderPanel();
    const enable = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Show Anthropic models in picker",
    );
    if (!enable) throw new Error("Missing disabled service visibility switch");
    expect(enable.props.checked).toBe(false);
    (enable.props.onCheckedChange as (checked: boolean) => void)(true);
    const enabledSettings: UnifiedSettings = {
      ...disabledSettings,
      ...settingsState.updateClientSettings.mock.lastCall?.[0],
    };
    settingsState.value = enabledSettings;
    expect(enabledSettings.providerModelPreferences?.[piId]?.hiddenModels).toEqual([
      "venice/custom",
    ]);
    expect(
      getAppModelOptionsForInstance(enabledSettings, entry).map((model) => model.slug),
    ).toEqual(["anthropic/model", "anthropic/custom", "openai/custom"]);
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("updates only selected service custom models through the real instance mutation", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [piId]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
          config: { binaryPath: "pi-custom", customModels: ["openai/custom", "anthropic/old"] },
        },
      },
    };
    const panel = renderPanel();
    const editor = visitElements(
      visitElements(panel, (element) => element.type === PiConnectionDetails),
      (element) => element.type === ProviderModelsSection,
    );
    if (!editor) throw new Error("Missing selected service model editor");
    expect((editor.props.customModels as { slug: string }[]).map((model) => model.slug)).toEqual([
      "anthropic/old",
    ]);
    (editor.props.onChange as (models: { slug: string; name: string }[]) => void)([
      { slug: "anthropic/new", name: "anthropic/new" },
    ]);
    await flushPromises();
    expect(settingsState.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: piId,
        instance: {
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
          config: { binaryPath: "pi-custom", customModels: ["openai/custom", "anthropic/new"] },
        },
      },
      expect.any(Object),
    );
  });

  it("guards native model preference callbacks when environment settings permission is revoked", () => {
    commands.canWriteSettings = false;
    const panel = renderPanel();
    const editor = visitElements(
      visitElements(panel, (element) => element.type === PiConnectionDetails),
      (element) => element.type === ProviderModelsSection,
    );
    if (!editor) throw new Error("Missing native model editor");
    expect(editor.props.canWritePreferences).toBe(false);
    (editor.props.onHiddenModelsChange as (models: string[]) => void)(["anthropic/model"]);
    (editor.props.onFavoriteModelsChange as (models: string[]) => void)(["anthropic/model"]);
    expect(settingsState.updateClientSettings).not.toHaveBeenCalled();
  });

  it("saves API keys to the selected real environment, runtime and native service with redacted input", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [customId]: { driver: ProviderDriverKind.make("pi"), enabled: true } },
    };
    commands.saveCredentials.mockResolvedValue({
      _tag: "Success",
      value: { instanceId: customId, service: "anthropic", configured: true },
    });
    const panel = renderPanel({ targetInstanceId: customId });
    const form = visitElements(panel, (element) => element.type === PiConnectionCredentialsForm);
    if (!form) throw new Error("Missing native API key form");
    expect(form.props.environmentId).toBe(environmentId);
    expect(form.props.instanceId).toBe(customId);
    expect(form.props.service).toBe("anthropic");
    expect(
      await (form.props.onSaveApiKey as (apiKey: string) => Promise<boolean>)(
        "private-key-fixture",
      ),
    ).toBe(true);
    const request = commands.saveCredentials.mock.lastCall?.[0];
    expect(request).toEqual({
      environmentId,
      input: {
        instanceId: customId,
        service: "anthropic",
        apiKey: expect.anything(),
        consent: true,
      },
    });
    expect(Redacted.value(request.input.apiKey)).toBe("private-key-fixture");
    expect(JSON.stringify(request)).not.toContain("private-key-fixture");
    (form.props.onSaved as () => void)();
    expect(commands.nativeRefresh).toHaveBeenCalledOnce();
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
  });

  it("does not accept a credential response for a different service or promote disconnected native services", async () => {
    commands.saveCredentials.mockResolvedValue({
      _tag: "Success",
      value: { instanceId: piId, service: "other", configured: true },
    });
    let panel = renderPanel();
    const form = visitElements(panel, (element) => element.type === PiConnectionCredentialsForm);
    if (!form) throw new Error("Missing API key form");
    expect(
      await (form.props.onSaveApiKey as (apiKey: string) => Promise<boolean>)(
        "private-key-fixture",
      ),
    ).toBe(false);
    panel = renderPanel();
    const rail = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Native providers",
    );
    expect(JSON.stringify(rail)).not.toContain("OpenAI");
    expect(commands.nativeRefresh).not.toHaveBeenCalled();
  });

  it("hides historical explicitly configured providers without removing them", () => {
    const grokId = ProviderInstanceId.make("grok");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [grokId]: { driver: ProviderDriverKind.make("grok"), enabled: false },
      },
    };
    const panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props.instanceId === grokId && element.props.mode === "list",
      ),
    ).toBeNull();
  });

  it("hides historical legacy provider configuration without removing it", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        grok: {
          ...DEFAULT_UNIFIED_SETTINGS.providers.grok,
          enabled: false,
          binaryPath: "/custom/grok",
        },
      },
    };
    const panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props.instanceId === "grok" && element.props.mode === "list",
      ),
    ).toBeNull();
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.updateEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.mutationEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(panel, isRefreshButton);
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { refreshModels: true },
    });

    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === piId && typeof element.props.onRunUpdate === "function",
    );
    expect(providerCard).not.toBeNull();
    (providerCard?.props.onRunUpdate as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("pi"), instanceId: piId },
    });
  });

  it("opens the requested provider instance instead of the first provider", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("pi"), enabled: true },
      },
    };
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(customId);
  });

  it.each([
    ["onFavoriteModelsChange", { favorites: [{ provider: piId, model: "chosen" }] }],
    [
      "onHiddenModelsChange",
      { providerModelPreferences: { [piId]: { hiddenModels: ["chosen"], modelOrder: [] } } },
    ],
    [
      "onModelOrderChange",
      { providerModelPreferences: { [piId]: { hiddenModels: [], modelOrder: ["chosen"] } } },
    ],
  ])("saves %s on this device without changing the selected server", (action, expected) => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const editor = visitElements(
      panel,
      (element) => element.props.instanceId === piId && element.props.mode === "editor",
    );
    expect(editor).not.toBeNull();
    if (!editor) throw new Error("Provider editor was not rendered");
    (editor.props[action] as (models: string[]) => void)(["chosen"]);
    expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith(expected);
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("does not substitute another account when the requested instance was removed", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    expect(visitElements(panel, (element) => element.props.mode === "editor")).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps provider selection available while write controls are read only", () => {
    commands.canWriteSettings = false;
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
        },
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();

    selectRuntime(panel, customId);

    panel = renderPanel({ readOnly: true });
    const customEditor = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customEditor).not.toBeNull();

    const notice = visitElements(panel, (element) => element.props.title === "Limited permissions");
    expect(notice).not.toBeNull();

    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).not.toBeNull();
  });

  it("offers the disconnected native service chooser instead of an add-harness wizard", () => {
    let panel = renderPanel();
    const add = visitElements(panel, isAddProviderButton);
    if (!add) throw new Error("Missing Add provider action.");
    (add.props.onClick as () => void)();
    panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props["aria-label"] === "Available native providers",
      ),
    ).not.toBeNull();

    commands.canManageProviders = false;
    panel = renderPanel({ readOnly: true });
    expect(
      visitElements(
        panel,
        (element) => element.props["aria-label"] === "Available native providers",
      ),
    ).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps Advanced visible when search targets the provider health interval", () => {
    let panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();

    settingsSearchState.targetId = "provider-health-check-interval";
    panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [piId]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    let panel = renderPanel();
    selectRuntime(panel, customId);
    panel = renderPanel();
    const customCard = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customCard).not.toBeNull();
    (customCard?.props.onDelete as (() => void) | undefined)?.();
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenLastCalledWith({
      operation: "remove",
      instanceId: customId,
    });

    settingsState.mutateProviderInstance.mockClear();
    selectRuntime(panel, piId);
    panel = renderPanel();
    const defaultCard = visitElements(
      panel,
      (element) => element.props.instanceId === piId && element.props.mode === "editor",
    );
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    const [resetMutation, resetPatch] = settingsState.mutateProviderInstance.mock.lastCall ?? [];
    expect(resetMutation).toEqual({ operation: "remove", instanceId: piId });
    expect(Object.keys(resetPatch ?? {}).sort()).toEqual(["providers"]);
    expect(resetPatch).not.toHaveProperty("favorites");
    expect(resetPatch).not.toHaveProperty("providerModelPreferences");
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    let panel = renderPanel();
    selectRuntime(panel, customId);
    panel = renderPanel();
    const advanced = visitElements(panel, (element) => element.props.title === "Advanced");
    const runtimeSettings = visitElements(advanced, (element) => element.type === "details");
    const card = visitElements(
      runtimeSettings,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(card).not.toBeNull();
    if (!card) throw new Error("Missing selected runtime editor in Advanced settings");
    expect(card.props.onUpdate).toBeTypeOf("function");
    const next = {
      driver: ProviderDriverKind.make("pi"),
      enabled: false,
      displayName: "Work",
    };
    (card.props.onUpdate as (instance: typeof next) => void)(next);
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenCalledWith(
      { operation: "upsert", instanceId: customId, instance: next },
      {},
    );
  });

  it("does not expose or delete historical ACP instances", () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_devin");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "devin" },
        },
      },
    };
    atoms.providers = [
      { ...provider(), instanceId, driver: ProviderDriverKind.make("acpRegistry") },
    ];
    const panel = renderPanel({ targetInstanceId: instanceId });
    expect(visitElements(panel, (element) => element.props.instanceId === instanceId)).toBeNull();
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
    expect(commands.uninstall).not.toHaveBeenCalled();
    expect(commands.acceptUrlAuth).not.toHaveBeenCalled();
  });
});
