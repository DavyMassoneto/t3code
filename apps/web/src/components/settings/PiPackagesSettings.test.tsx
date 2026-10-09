import { EnvironmentId, ProjectId, ProviderInstanceId, PiPackageError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  mutate: vi.fn(),
  toast: vi.fn(),
  permissions: { list: true, search: true, mutate: true },
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/piPackages", () => ({
  createPiPackageCommands: () =>
    Object.fromEntries(
      ["list", "search", "mutate"].map((kind) => [
        kind,
        {
          kind,
          permissionAtom: (environmentId: string) => ({ kind, environmentId }),
        },
      ]),
    ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { kind: keyof typeof fixture.permissions }) =>
    fixture.permissions[atom.kind],
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: "list" | "search" | "mutate" }) => fixture[command.kind],
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "project-a", environmentId: "environment-a", title: "Workspace A" },
    { id: "project-b", environmentId: "environment-b", title: "Workspace B" },
  ],
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: fixture.toast } }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({
  Input: (props: object) => <input {...props} />,
}));
vi.mock("../ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
    name = "package-scope",
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
    name?: string;
  }) => (
    <select
      name={name}
      aria-label="Package scope"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectValue: ({ children }: { children: ReactNode }) => (
    <span data-slot="select-value">{children}</span>
  ),
}));
vi.mock("../ui/alert-dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogPopup: Container,
    AlertDialogHeader: Container,
    AlertDialogFooter: Container,
    AlertDialogTitle: Container,
    AlertDialogDescription: Container,
  };
});

import { PiPackagesSettings, isPiPackageInstalled } from "./PiPackagesSettings";

const environmentId = EnvironmentId.make("environment-a");
const instanceId = ProviderInstanceId.make("pi-main");
const exactSource = "git:https://example.test/native/pi-package#v1";
const emptyList = { scopeLabel: "Global", packages: [] };
const installedList = {
  scopeLabel: "Global",
  packages: [{ source: exactSource, scope: "global", filtered: true }],
};
let renderer: ReactTestRenderer;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function button(label: string) {
  return renderer.root
    .findAllByType("button")
    .find((entry) => entry.props["aria-label"] === label || entry.children.join("") === label)!;
}
function select(name: string) {
  return renderer.root.findAllByType("select").find((entry) => entry.props.name === name)!;
}
async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
  });
}
async function typeSource(source: string) {
  if (!renderer.root.findAllByProps({ "aria-label": "Pi package source" }).length)
    await click("Installed");
  await act(async () => {
    renderer.root
      .findByProps({ "aria-label": "Pi package source" })
      .props.onChange({ target: { value: source } });
  });
}
function text() {
  return JSON.stringify(renderer.toJSON());
}
async function selectDestination(scope: "global" | "project") {
  await act(async () =>
    renderer.update(
      <PiPackagesSettings
        environmentId={environmentId}
        instanceId={instanceId}
        destination={
          scope === "project" ? { scope, projectId: ProjectId.make("project-a") } : { scope }
        }
      />,
    ),
  );
}
async function mount() {
  await act(async () => {
    renderer = create(
      <PiPackagesSettings
        environmentId={environmentId}
        instanceId={instanceId}
        destination={{ scope: "global" }}
      />,
    );
  });
}

describe("PiPackagesSettings fixture RPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.permissions = { list: true, search: true, mutate: true };
    fixture.list.mockReset().mockResolvedValue(AsyncResult.success(installedList));
    fixture.search.mockReset().mockResolvedValue(
      AsyncResult.success({
        catalogUrl: "https://example.test/catalog",
        packages: [
          {
            name: "native-demo",
            source: "npm:native-demo",
            description: "Native resources",
            types: ["extension", "skill", "theme", "prompt"],
            url: "https://example.test/package",
          },
        ],
      }),
    );
    fixture.mutate.mockReset().mockResolvedValue(AsyncResult.success(emptyList));
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
  });

  it("matches known npm package identities without guessing aliases, pinned versions, Git or local basenames", () => {
    expect(isPiPackageInstalled("npm:demo", ["npm:demo@1.2.3"])).toBe(true);
    expect(isPiPackageInstalled("npm:@team/demo", ["npm:@team/demo@latest"])).toBe(true);
    expect(isPiPackageInstalled("npm:foo", ["npm:foo@npm:bar"])).toBe(false);
    expect(isPiPackageInstalled("npm:demo@1", ["npm:demo@2"])).toBe(false);
    expect(isPiPackageInstalled("npm:demo@1", ["npm:demo@1"])).toBe(true);
    expect(
      isPiPackageInstalled("git:https://example.test/demo#v1", ["git:https://other.test/demo#v1"]),
    ).toBe(false);
    expect(isPiPackageInstalled("/first/demo", ["/second/demo"])).toBe(false);
  });

  it("shows Installed markers for known npm packages and never installs them implicitly", async () => {
    fixture.list.mockResolvedValueOnce(
      AsyncResult.success({
        scopeLabel: "Global",
        packages: [{ source: "npm:native-demo@1.2.3", scope: "global", filtered: false }],
      }),
    );
    await mount();
    await click("Discover");
    const installed = button("Install native-demo");
    expect(installed.children.join("")).toBe("Installed");
    expect(installed.props.disabled).toBe(true);
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("sends category and sorting filters to the official catalog and resets them to page one", async () => {
    await mount();
    await click("Discover");
    await act(async () =>
      renderer.root
        .findAllByType("select")
        .find((entry) => entry.props.name === "package-category")!
        .props.onChange({ target: { value: "theme" } }),
    );
    expect(fixture.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "", type: "theme", sort: "downloads", page: 1 },
    });
    await act(async () =>
      renderer.root
        .findAllByType("select")
        .find((entry) => entry.props.name === "package-sort")!
        .props.onChange({ target: { value: "recent" } }),
    );
    expect(fixture.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "", type: "theme", sort: "recent", page: 1 },
    });
    await act(async () =>
      renderer.root
        .findAllByType("select")
        .find((entry) => entry.props.name === "package-category")!
        .props.onChange({ target: { value: "all" } }),
    );
    expect(fixture.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "", sort: "recent", page: 1 },
    });
  });

  it("uses real navigation flags and metadata without presenting catalog totals as filtered matches", async () => {
    const packages = [
      {
        name: "real-package",
        source: "npm:real-package",
        description: "Actual catalog description",
        types: ["skill"],
        url: "https://pi.dev/packages/real-package",
        author: "actual-author",
        monthlyDownloads: 0,
        publishedAt: "2026-10-08T10:00:00.000Z",
      },
    ];
    fixture.search.mockResolvedValueOnce(
      AsyncResult.success({
        catalogUrl: "https://pi.dev/packages",
        packages,
        pagination: {
          page: 1,
          totalPages: 109,
          total: 5444,
          catalogTotal: 5444,
          rangeStart: 1,
          rangeEnd: 1,
          hasNext: true,
          hasPrevious: false,
        },
      }),
    );
    fixture.search.mockResolvedValueOnce(
      AsyncResult.success({
        catalogUrl: "https://pi.dev/packages?page=2",
        packages,
        pagination: {
          page: 2,
          totalPages: 109,
          total: 5444,
          catalogTotal: 5444,
          rangeStart: 2,
          rangeEnd: 2,
          hasNext: false,
          hasPrevious: true,
        },
      }),
    );
    await mount();
    await click("Discover");
    expect(button("Previous").props.disabled).toBe(true);
    expect(button("Next").props.disabled).toBe(false);
    expect(text()).toContain("actual-author");
    expect(text()).toContain("0 monthly downloads");
    expect(text()).toContain("1–1 shown");
    expect(renderer.root.findByType("time").props.dateTime).toBe("2026-10-08T10:00:00.000Z");
    await click("Next");
    expect(fixture.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "", sort: "downloads", page: 2 },
    });
    expect(button("Next").props.disabled).toBe(true);
    expect(button("Previous").props.disabled).toBe(false);
    expect(text()).not.toContain("of 109");
    await click("Previous");
    expect(fixture.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "", sort: "downloads", page: 1 },
    });
  });

  it("does not fabricate filtered page counts or navigation for zero matches", async () => {
    fixture.search.mockResolvedValueOnce(
      AsyncResult.success({
        catalogUrl: "https://pi.dev/packages",
        packages: [],
        pagination: { page: 1, total: 0, catalogTotal: 5444, hasNext: false, hasPrevious: false },
      }),
    );
    await mount();
    await click("Discover");
    expect(text()).toContain("No official packages found.");
    expect(text()).toContain("0 results shown");
    expect(text()).toContain(`Catalog: ${(5444).toLocaleString()} packages`);
    expect(text()).not.toContain("of 109");
    expect(button("Next").props.disabled).toBe(true);
  });

  it("discards gallery responses after leaving Discover or losing permission", async () => {
    const pending =
      deferred<ReturnType<typeof AsyncResult.success<{ catalogUrl: string; packages: [] }>>>();
    fixture.search.mockReturnValueOnce(pending.promise);
    await mount();
    await click("Discover");
    await click("Installed");
    await act(async () =>
      pending.resolve(AsyncResult.success({ catalogUrl: "stale", packages: [] })),
    );
    expect(text()).not.toContain("No official packages found");
    const denied =
      deferred<ReturnType<typeof AsyncResult.success<{ catalogUrl: string; packages: [] }>>>();
    fixture.search.mockReturnValueOnce(denied.promise);
    await click("Discover");
    fixture.permissions.search = false;
    await act(async () =>
      renderer.update(
        <PiPackagesSettings
          environmentId={environmentId}
          instanceId={instanceId}
          destination={{ scope: "global" }}
        />,
      ),
    );
    await act(async () =>
      denied.resolve(AsyncResult.success({ catalogUrl: "denied", packages: [] })),
    );
    await click("Discover");
    expect(text()).toContain("Catalog discovery is unavailable");
    expect(text()).not.toContain("No official packages found");
  });

  it("supports keyboard tab navigation and associates the active panel with its tab", async () => {
    await mount();
    const focus = vi.fn();
    const preventDefault = vi.fn();
    await act(async () =>
      renderer.root.findByProps({ role: "tablist" }).props.onKeyDown({
        key: "ArrowRight",
        preventDefault,
        currentTarget: { querySelector: () => ({ focus }) },
      }),
    );
    expect(preventDefault).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(button("Discover").props["aria-selected"]).toBe(true);
    expect(button("Installed").props.tabIndex).toBe(-1);
    expect(renderer.root.findByProps({ role: "tabpanel" }).props["aria-labelledby"]).toBe(
      button("Discover").props.id,
    );
    expect(fixture.search).toHaveBeenCalledTimes(1);
  });

  it("does not let an older category response overwrite the currently sorted gallery", async () => {
    await mount();
    await click("Discover");
    const older =
      deferred<ReturnType<typeof AsyncResult.success<{ catalogUrl: string; packages: [] }>>>();
    fixture.search.mockReturnValueOnce(older.promise);
    await act(async () =>
      select("package-category").props.onChange({ target: { value: "theme" } }),
    );
    await act(async () => select("package-sort").props.onChange({ target: { value: "name" } }));
    await act(async () =>
      older.resolve(AsyncResult.success({ catalogUrl: "old-category", packages: [] })),
    );
    expect(button("Install native-demo").children.join("")).toBe("Install");
    expect(text()).not.toContain("No official packages found");
    expect(fixture.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "", type: "theme", sort: "name", page: 1 },
    });
  });

  it("opens Installed by default and fetches the gallery only when Discover is opened", async () => {
    await mount();
    expect(renderer.root.findAllByType("h3")).toHaveLength(0);
    expect(text()).not.toContain("Codex");
    expect(fixture.search).not.toHaveBeenCalled();
    const sections = renderer.root.findAllByType("section");
    expect(sections.map((entry) => entry.props["aria-label"])).toEqual([
      "Pi packages",
      "Installed plugins",
    ]);
    expect(renderer.root.findByType("summary").children.join("")).toBe(
      "Install from a package source",
    );
    expect(button("Installed").props["aria-selected"]).toBe(true);
    expect(renderer.root.findByProps({ role: "tabpanel" }).props["aria-labelledby"]).toBe(
      button("Installed").props.id,
    );
    await click("Discover");
    expect(fixture.search).toHaveBeenCalledWith({
      environmentId,
      input: { query: "", sort: "downloads", page: 1 },
    });
    expect(renderer.root.findAllByProps({ "aria-label": "Installed packages" })).toHaveLength(0);
    expect(button("Install native-demo").children.join("")).toBe("Install");
  });

  it.each([
    ["npm:pi-tools@1.2.3", "pi-tools"],
    ["npm:@team/pi-tools@latest", "@team/pi-tools"],
    ["npm:@team/pi-tools", "@team/pi-tools"],
    ["git:https://example.test/team/pi-tools.git#release", "pi-tools"],
    ["git:git@github.com:team/pi-tools.git#release", "pi-tools"],
    ["C:\\Users\\someone\\native packages\\pi-tools", "pi-tools"],
    ["C:\\native\\folder#tag\\pi-tools", "pi-tools"],
    ["/native/packages/pi-tools/", "pi-tools"],
  ])(
    "presents %s as a concise package name while preserving the exact source",
    async (source, name) => {
      fixture.list.mockResolvedValueOnce(
        AsyncResult.success({
          scopeLabel: "C:/very/long/private/runtime/location",
          packages: [{ source, scope: "global", filtered: false }],
        }),
      );
      await mount();
      const rows = renderer.root.findByProps({ "aria-label": "Installed packages" });
      expect(rows.findAllByType("p").some((entry) => entry.children.join("") === name)).toBe(true);
      const exact = rows.findByProps({ "aria-label": `Package source: ${source}` });
      expect(exact.children.join("")).toBe(source);
      expect(exact.props.title).toBe(source);
      expect(button(`Update ${source}`).children.join("")).toBe("Update");
      expect(button(`Remove ${source}`).children.join("")).toBe("Remove");
      const header = renderer.root
        .findAllByType("h4")
        .find((entry) => entry.children.join("") === "Installed (1)")!;
      expect(header.children.join("")).not.toContain("C:/");
      await click(`Update ${source}`);
      expect(fixture.mutate).not.toHaveBeenCalled();
      await click("I trust this source - continue");
      expect(fixture.mutate).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, scope: "global", action: "update", source, consent: true },
      });
    },
  );

  it("uses the header destination without a redundant local scope selector", async () => {
    await mount();
    expect(text()).not.toContain("Install for");
    expect(renderer.root.findAllByType("select")).toHaveLength(0);
    await selectDestination("project");
    expect(fixture.list).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, scope: "project", projectId: ProjectId.make("project-a") },
    });
  });

  it("supports keyboard catalog search without installing anything automatically", async () => {
    await mount();
    await click("Discover");
    const input = renderer.root.findByProps({ "aria-label": "Search official Pi packages" });
    await act(async () => input.props.onChange({ target: { value: "themes" } }));
    const preventDefault = vi.fn();
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Search official Pi packages" })
        .props.onKeyDown({ key: "Enter", preventDefault }),
    );
    expect(preventDefault).toHaveBeenCalled();
    expect(fixture.search).toHaveBeenCalledWith({
      environmentId,
      input: { query: "themes", sort: "downloads", page: 1 },
    });
    expect(button("Install native-demo").children.join("")).toBe("Install");
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("lists the selected instance in the header-selected project", async () => {
    await mount();
    expect(fixture.list).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, scope: "global" },
    });
    expect(text()).toContain(exactSource);
    await selectDestination("project");
    expect(fixture.list).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, scope: "project", projectId: ProjectId.make("project-a") },
    });
  });

  it.each(["npm:demo@1", "git:https://example.test/demo#main", "C:/native packages/demo"])(
    "requires explicit code-execution consent for %s",
    async (source) => {
      await mount();
      await typeSource(source);
      await click("Install source");
      expect(fixture.mutate).not.toHaveBeenCalled();
      expect(text()).toContain("execute third-party code");
      await click("I trust this source - continue");
      expect(fixture.mutate).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, scope: "global", action: "install", source, consent: true },
      });
      expect(text()).toContain("No packages installed");
      expect(fixture.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
    },
  );

  it("searches the official catalog and confirms catalog installs", async () => {
    await mount();
    await click("Discover");
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Search official Pi packages" })
        .props.onChange({ target: { value: "native" } }),
    );
    await click("Search");
    expect(fixture.search).toHaveBeenCalledWith({
      environmentId,
      input: { query: "native", sort: "downloads", page: 1 },
    });
    const catalog = renderer.root.findByProps({ "aria-label": "Catalog packages" });
    for (const type of ["extension", "skill", "theme", "prompt"]) {
      expect(catalog.findAllByType("span").some((entry) => entry.children.join("") === type)).toBe(
        true,
      );
    }
    await click("Install native-demo");
    expect(fixture.mutate).not.toHaveBeenCalled();
    await click("Cancel");
    expect(fixture.mutate).not.toHaveBeenCalled();
    await click("Install native-demo");
    await click("I trust this source - continue");
    expect(fixture.mutate).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        action: "install",
        source: "npm:native-demo",
        consent: true,
      },
    });
  });

  it.each(["update", "remove"])("preserves the exact installed source for %s", async (action) => {
    await mount();
    await click(`${action === "update" ? "Update" : "Remove"} ${exactSource}`);
    expect(fixture.mutate).not.toHaveBeenCalled();
    await click(action === "update" ? "I trust this source - continue" : "Confirm removal");
    expect(fixture.mutate).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, scope: "global", action, source: exactSource, consent: true },
    });
  });

  it("disables each command according to its permission atom", async () => {
    fixture.permissions = { list: false, search: false, mutate: false };
    await mount();
    expect(fixture.list).not.toHaveBeenCalled();
    expect(button("Install source").props.disabled).toBe(true);
    expect(button("Refresh packages").props.disabled).toBe(true);
    expect(text()).toContain("providers:manage");
    await click("Discover");
    expect(button("Search").props.disabled).toBe(true);
    expect(fixture.search).not.toHaveBeenCalled();
  });

  it("allows discovery without package-management permission", async () => {
    fixture.permissions.mutate = false;
    await mount();
    expect(button(`Update ${exactSource}`).props.disabled).toBe(true);
    expect(button(`Remove ${exactSource}`).props.disabled).toBe(true);
    await click("Discover");
    expect(fixture.list).toHaveBeenCalled();
    expect(fixture.search).toHaveBeenCalled();
    expect(button("Install native-demo").props.disabled).toBe(true);
  });

  it("targets project mutations and drops pending consent when returning to global", async () => {
    await mount();
    await selectDestination("project");
    await typeSource("npm:project-demo");
    await click("Install source");
    await click("I trust this source - continue");
    expect(fixture.mutate).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "project",
        projectId: ProjectId.make("project-a"),
        action: "install",
        source: "npm:project-demo",
        consent: true,
      },
    });
    await click("Install source");
    await selectDestination("global");
    expect(text()).not.toContain("alertdialog");
    expect(renderer.root.findByProps({ "aria-label": "Pi package source" }).props.value).toBe("");
  });

  it.each(["update", "remove"] as const)(
    "uses the header project destination for %s",
    async (action) => {
      await mount();
      await selectDestination("project");
      await click(`${action === "update" ? "Update" : "Remove"} ${exactSource}`);
      await click(action === "update" ? "I trust this source - continue" : "Confirm removal");
      expect(fixture.mutate).toHaveBeenLastCalledWith({
        environmentId,
        input: {
          instanceId,
          scope: "project",
          projectId: ProjectId.make("project-a"),
          action,
          source: exactSource,
          consent: true,
        },
      });
    },
  );

  it("drops confirmation and stale failure toasts when permissions are revoked", async () => {
    const pendingMutation = deferred<ReturnType<typeof AsyncResult.failure>>();
    fixture.mutate.mockReturnValueOnce(pendingMutation.promise);
    await mount();
    await typeSource("npm:demo");
    await click("Install source");
    await click("I trust this source - continue");
    fixture.permissions.mutate = false;
    await act(async () =>
      renderer.update(
        <PiPackagesSettings
          environmentId={environmentId}
          instanceId={instanceId}
          destination={{ scope: "global" }}
        />,
      ),
    );
    await act(async () =>
      pendingMutation.resolve(
        AsyncResult.failure(Cause.fail(new PiPackageError({ message: "Old destination failed" }))),
      ),
    );
    expect(text()).not.toContain("Old destination failed");
    expect(text()).not.toContain("alertdialog");
    expect(fixture.toast).not.toHaveBeenCalled();
    expect(button("Install source").props.disabled).toBe(true);
  });

  it("locks duplicate confirmations and does not let older lists overwrite a mutation result", async () => {
    await mount();
    const oldList = deferred<ReturnType<typeof AsyncResult.success<typeof installedList>>>();
    const pendingMutation = deferred<ReturnType<typeof AsyncResult.success<typeof emptyList>>>();
    fixture.list.mockReturnValueOnce(oldList.promise);
    fixture.mutate.mockReturnValueOnce(pendingMutation.promise);
    await click("Refresh packages");
    await click(`Remove ${exactSource}`);
    const confirm = button("Confirm removal").props.onClick;
    await act(async () => {
      confirm();
      confirm();
    });
    expect(fixture.mutate).toHaveBeenCalledTimes(1);
    await act(async () => pendingMutation.resolve(AsyncResult.success(emptyList)));
    await act(async () => oldList.resolve(AsyncResult.success(installedList)));
    expect(text()).not.toContain(exactSource);
    expect(text()).toContain("No packages installed");
  });

  it("suppresses interruption errors and clears busy states", async () => {
    fixture.mutate.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await mount();
    await click(`Update ${exactSource}`);
    await click("I trust this source - continue");
    expect(fixture.toast).not.toHaveBeenCalled();
    expect(text()).not.toContain("alertdialog");
    expect(button(`Update ${exactSource}`).props.disabled).toBe(false);
  });

  it.each(["-dangerous", "", "npm:demo\n--flag"])(
    "rejects invalid manual source %j",
    async (source) => {
      await mount();
      await typeSource(source);
      expect(button("Install source").props.disabled).toBe(true);
    },
  );

  it.each(["environment", "instance", "project"])(
    "ignores stale list, search, and mutation completions after switching %s",
    async (destination) => {
      await mount();
      const oldList = deferred<ReturnType<typeof AsyncResult.success<typeof installedList>>>();
      const oldSearch =
        deferred<ReturnType<typeof AsyncResult.success<{ catalogUrl: string; packages: [] }>>>();
      const oldMutation = deferred<ReturnType<typeof AsyncResult.success<typeof installedList>>>();
      fixture.list
        .mockReturnValueOnce(oldList.promise)
        .mockResolvedValue(AsyncResult.success(emptyList));
      fixture.search.mockReturnValueOnce(oldSearch.promise);
      fixture.mutate.mockReturnValueOnce(oldMutation.promise);
      await click("Refresh packages");
      await click("Discover");
      await typeSource("npm:demo");
      await click("Install source");
      await click("I trust this source - continue");
      if (destination === "project") {
        await selectDestination("project");
      } else {
        await act(async () =>
          renderer.update(
            <PiPackagesSettings
              destination={{ scope: "global" }}
              environmentId={
                destination === "environment" ? EnvironmentId.make("environment-b") : environmentId
              }
              instanceId={
                destination === "instance" ? ProviderInstanceId.make("pi-other") : instanceId
              }
            />,
          ),
        );
      }
      await act(async () => {
        oldList.resolve(AsyncResult.success(installedList));
        oldSearch.resolve(AsyncResult.success({ catalogUrl: "stale-catalog", packages: [] }));
        oldMutation.resolve(AsyncResult.success(installedList));
      });
      expect(text()).not.toContain(exactSource);
      expect(text()).not.toContain("No official packages found");
      expect(text()).not.toContain("alertdialog");
      expect(fixture.toast).not.toHaveBeenCalled();
    },
  );

  it("shows list and search errors and reports mutation failures without losing installed sources", async () => {
    const failed = AsyncResult.failure(
      Cause.fail(new PiPackageError({ message: "Fixture denied" })),
    );
    fixture.list.mockResolvedValueOnce(failed);
    await mount();
    expect(text()).toContain("Fixture denied");
    await click("Refresh packages");
    fixture.search.mockResolvedValueOnce(failed);
    await click("Discover");
    expect(text()).toContain("Fixture denied");
    fixture.mutate.mockResolvedValueOnce(failed);
    await click("Installed");
    await click(`Update ${exactSource}`);
    await click("I trust this source - continue");
    expect(text()).toContain(exactSource);
    expect(fixture.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "Fixture denied" }),
    );
  });
});
