import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { resolvePluginsPackageDestination } from "./pluginsPackageScope";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const environments = [
  { environmentId: local, label: "Local" },
  { environmentId: remote, label: "Remote" },
];
function member(environmentId: EnvironmentId, workspaceRoot: string): SidebarProjectGroupMember {
  return {
    id: ProjectId.make("same-id"),
    environmentId,
    title: "Repo",
    workspaceRoot,
    physicalProjectKey: `${environmentId}:${workspaceRoot}`,
    environmentLabel: environmentId,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
}
const localProject = member(local, "/local/repo");
const remoteProject = member(remote, "/remote/repo");
const projects = [localProject, remoteProject];
function group(members: readonly SidebarProjectGroupMember[]): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey: "logical-repo",
    displayName: "Repo",
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
  };
}
function resolve(
  search: SettingsScopeSearch,
  environmentId: EnvironmentId | null = remote,
  members = projects,
) {
  return resolvePluginsPackageDestination(
    resolveSettingsScope(search, [group(members)], environments),
    environmentId,
    projects,
  );
}

describe("Plugins header destination", () => {
  it("maps All projects on the selected machine to global", () => {
    expect(resolve({ machine: remote })).toEqual({ scope: "global" });
  });
  it("maps a logical project to its actual record on the selected owning environment", () => {
    expect(resolve({ project: "logical-repo", machine: remote })).toEqual({
      scope: "project",
      projectId: remoteProject.id,
    });
    expect(resolve({ project: "logical-repo", machine: remote }, local)).toContain(
      "owning machine",
    );
  });
  it("maps a checkout rooted at the project workspace to project scope", () => {
    expect(
      resolve({ project: "logical-repo", checkout: remoteProject.physicalProjectKey }),
    ).toEqual({ scope: "project", projectId: remoteProject.id });
  });
  it("rejects a checkout directory the existing projectId API cannot target", () => {
    const checkout = {
      ...remoteProject,
      workspaceRoot: "/remote/worktree",
      physicalProjectKey: "remote:worktree",
    };
    expect(
      resolve({ project: "logical-repo", checkout: checkout.physicalProjectKey }, remote, [
        localProject,
        checkout,
      ]),
    ).toContain("not this checkout directory");
  });
  it("requires disambiguation rather than choosing the first checkout or machine", () => {
    expect(resolve({ project: "logical-repo" })).toContain("owning machine");
    expect(resolve({})).toContain("owning machine");
    const second = {
      ...remoteProject,
      id: ProjectId.make("second"),
      physicalProjectKey: "remote:second",
    };
    expect(
      resolve({ project: "logical-repo", machine: remote }, remote, [...projects, second]),
    ).toContain("one project checkout");
  });
  it.each([
    { machine: "missing" },
    { project: "missing", machine: remote },
    { project: "logical-repo", machine: remote, checkout: "missing" },
  ])("preserves unavailable header selection %j without falling back global", (search) => {
    expect(typeof resolve(search)).toBe("string");
  });
  it("rejects a disconnected machine and a removed or foreign project record", () => {
    expect(resolve({ project: "logical-repo", machine: remote }, null)).toContain("Connect");
    const scope = resolveSettingsScope(
      { project: "logical-repo", machine: remote },
      [group(projects)],
      environments,
    );
    expect(resolvePluginsPackageDestination(scope, remote, [localProject])).toContain(
      "unavailable",
    );
  });
});
