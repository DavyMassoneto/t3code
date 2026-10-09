import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  presentations: new Map<
    EnvironmentId,
    {
      entry: { target: { label: string } };
      connection: { phase: string };
      serverConfig: { providers: readonly ServerProvider[] };
    }
  >(),
  list: vi.fn(),
  refreshProviders: vi.fn(async () => undefined),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "permissions"
      ? true
      : atom === "keybindings"
        ? DEFAULT_RESOLVED_KEYBINDINGS
        : state.presentations,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: "presentations" },
}));
vi.mock("../../state/piConnections", () => ({
  listPiConnections: { permissionAtom: () => "permissions" },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: "refresh" },
  primaryServerKeybindingsAtom: "keybindings",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "refresh" ? state.refreshProviders : state.list,
}));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useCanGoBack: () => false,
}));
vi.mock("../../state/usage", () => ({
  useUsage: () => {
    const environments = [...state.presentations].map(([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
      isPending: false,
      canReadDiagnostics: true,
      error: null,
      summary: null,
    }));
    return {
      merged: mergeUsage([], USAGE_CONTRACT_VERSION),
      environments,
      selectedEnvironments: environments,
      isPending: false,
      shown: null,
      isPartial: false,
      refresh: async () => undefined,
    };
  },
}));
vi.mock("./usagePagePreferences", () => ({
  readUsagePagePreferences: () => ({ metric: "limits", windowDays: 30 }),
  saveUsagePagePreferences: vi.fn(),
}));
vi.mock("../ui/button", () => ({ Button: "button", InlineButton: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipPopup: "div", TooltipTrigger: "div" }));
vi.mock("../ui/popover", () => ({ Popover: "div", PopoverPopup: "div", PopoverTrigger: "div" }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuCheckboxItem: "div",
  MenuItem: "div",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuTrigger: "div",
}));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: "span" }));
vi.mock("../settings/providerDriverMeta", () => ({ getDriverOption: () => ({ label: "Codex" }) }));

import { UsageLimitsSection } from "./UsageLimits";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { UsagePage } from "./UsagePage";
import { formatNativeMetricValue } from "./piProviderLimitsHelpers";

const first = EnvironmentId.make("remote-limits-first");
const second = EnvironmentId.make("remote-limits-second");
const now = Date.parse("2026-10-08T10:00:00Z");
const emptyMessage = "No provider on the selected environments reports subscription limits.";
function provider(instance: string, driver: "pi" | "codex" = "pi"): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instance),
    driver: ProviderDriverKind.make(driver),
    displayName: instance,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-08T10:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}
function presentation(label: string, providers: readonly ServerProvider[]) {
  return {
    entry: { target: { label } },
    connection: { phase: "connected" },
    serverConfig: { providers },
  };
}
let renderer: ReactTestRenderer;
function renderedText(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  return node.children?.map(renderedText).join("") ?? "";
}
const visibleText = () => renderedText(renderer.toJSON());
const section = (
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  hiddenProviders = new Set<"pi" | "codex">(),
  refreshToken = 0,
) => (
  <UsageLimitsSection
    selectedEnvironmentIds={selectedEnvironmentIds}
    hiddenProviders={hiddenProviders}
    now={now}
    refreshToken={refreshToken}
  />
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(now);
  state.refreshProviders.mockClear();
  state.list.mockReset();
  state.presentations = new Map([[first, presentation("Remote first", [provider("pi-work")])]]);
  state.list.mockImplementation(
    async ({ input }: { input: { instanceId: ProviderInstanceId } }) => ({
      _tag: "Success",
      value: { instanceId: input.instanceId, connections: [] },
    }),
  );
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Limits native and legacy integration", () => {
  it("reloads native metrics when the section refresh token changes without showing legacy empty copy", async () => {
    let remaining = 0;
    state.list.mockImplementation(
      async ({ input }: { input: { instanceId: ProviderInstanceId } }) => ({
        _tag: "Success",
        value: {
          instanceId: input.instanceId,
          connections: [
            {
              service: "venice",
              name: "Venice",
              configured: true,
              authentication: "managed-in-pi",
              authMethods: ["api_key"],
              limits: "unavailable",
              models: [],
              limitsDetails: {
                status: "available",
                checkedAt: "2026-10-08T10:00:00Z",
                source: "fixture",
                metrics: [
                  { id: "balance", label: "Balance", unit: "DIEM", remaining: remaining++ },
                ],
              },
            },
          ],
        },
      }),
    );
    await act(() => {
      renderer = create(section());
    });
    expect(visibleText()).toContain("0 DIEM");
    expect(visibleText()).not.toContain(emptyMessage);
    await act(() => renderer.update(section(null, new Set(), 1)));
    expect(state.list).toHaveBeenCalledTimes(2);
    expect(state.list).toHaveBeenLastCalledWith({
      environmentId: first,
      input: { instanceId: "pi-work", includeLimits: true },
    });
    expect(visibleText()).toContain("1 DIEM");
    expect(visibleText()).not.toContain("0 DIEM");
    expect(visibleText()).not.toContain(emptyMessage);
  });

  it("suppresses the misleading legacy empty state while native limits load", async () => {
    state.list.mockReturnValue(new Promise(() => {}));
    await act(() => {
      renderer = create(section());
    });
    expect(visibleText()).toContain("loading native provider limits");
    expect(visibleText()).not.toContain(emptyMessage);
  });

  it("preserves actual legacy subscription pools beside native services", async () => {
    const codex = provider("codex-account", "codex");
    state.presentations = new Map([
      [
        first,
        presentation("Remote first", [
          provider("pi-work"),
          {
            ...codex,
            usageLimits: {
              checkedAt: "2026-10-08T10:00:00Z",
              windows: [
                {
                  id: "five_hour",
                  kind: "session",
                  label: "Session",
                  usedPercent: 40,
                  windowDurationMins: 300,
                  resetsAt: "2026-10-08T12:00:00Z",
                },
              ],
            },
          },
        ]),
      ],
    ]);
    await act(() => {
      renderer = create(section());
    });
    expect(visibleText()).toContain("Session");
    expect(visibleText()).toContain("60%");
    expect(visibleText()).not.toContain(emptyMessage);
    await act(() => renderer.update(section(null, new Set(["codex"]))));
    expect(visibleText()).not.toContain("Session");
  });

  it("routes only selected remote environments, instances and visible providers", async () => {
    state.presentations.set(
      second,
      presentation("Remote second", [provider("pi-remote"), provider("pi-disabled")]),
    );
    const selected = state.presentations.get(second)!;
    selected.serverConfig = {
      providers: selected.serverConfig.providers.map((entry) =>
        entry.instanceId === "pi-disabled" ? { ...entry, enabled: false } : entry,
      ),
    };
    await act(() => {
      renderer = create(section(new Set([second])));
    });
    expect(state.list).toHaveBeenCalledExactlyOnceWith({
      environmentId: second,
      input: { instanceId: "pi-remote", includeLimits: true },
    });
    await act(() => renderer.update(section(new Set([second]), new Set(["pi"]))));
    expect(visibleText()).toContain(emptyMessage);
    expect(state.list).toHaveBeenCalledTimes(1);
  });

  it("does not request native services from disconnected environments", async () => {
    state.presentations.get(first)!.connection.phase = "disconnected";
    await act(() => {
      renderer = create(section());
    });
    expect(state.list).not.toHaveBeenCalled();
  });

  it("only suppresses the legacy empty state when explicitly requested", async () => {
    await act(() => {
      renderer = create(<UsageLimitsPooled presentations={new Map()} now={now} />);
    });
    expect(visibleText()).toContain(emptyMessage);
    await act(() =>
      renderer.update(<UsageLimitsPooled presentations={new Map()} now={now} suppressEmptyState />),
    );
    expect(visibleText()).not.toContain(emptyMessage);
  });

  it.each([0, 1])(
    "refreshes native balances from desktop page Refresh button %i even at the same timestamp",
    async (index) => {
      let balance = 0;
      state.list.mockImplementation(
        async ({ input }: { input: { instanceId: ProviderInstanceId } }) => ({
          _tag: "Success",
          value: {
            instanceId: input.instanceId,
            connections: [
              {
                service: "venice",
                name: "Venice",
                configured: true,
                authentication: "managed-in-pi",
                authMethods: ["api_key"],
                limits: "unavailable",
                models: [],
                limitsDetails: {
                  status: "available",
                  checkedAt: "2026-10-08T10:00:00Z",
                  source: "fixture",
                  metrics: [
                    { id: "balance", label: "USD balance", unit: "USD", remaining: balance++ },
                  ],
                },
              },
            ],
          },
        }),
      );
      await act(() => {
        renderer = create(<UsagePage />);
      });
      expect(visibleText()).toContain(formatNativeMetricValue(0, "USD"));
      expect(visibleText()).not.toContain(emptyMessage);
      expect(state.list).toHaveBeenCalledTimes(1);
      await act(async () => {
        renderer.root
          .findAll(
            (node) => node.type === "button" && node.props["aria-label"] === "Refresh limits",
          )
          [index]!.props.onClick();
      });
      expect(state.list).toHaveBeenCalledTimes(2);
      expect(visibleText()).toContain(formatNativeMetricValue(1, "USD"));
      expect(visibleText()).not.toContain(formatNativeMetricValue(0, "USD"));
    },
  );
});

// @vitest-environment jsdom
