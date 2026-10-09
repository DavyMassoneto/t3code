import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { Project } from "../../types";
import type { ResolvedSettingsScope } from "./settingsScope";

export type PluginsPackageDestination =
  | { readonly scope: "global" }
  | { readonly scope: "project"; readonly projectId: ProjectId };

export function resolvePluginsPackageDestination(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId | null,
  projects: readonly Pick<Project, "id" | "environmentId" | "workspaceRoot">[],
): PluginsPackageDestination | string {
  if (scope.kind === "unavailable") return scope.message;
  if (!environmentId) return "Connect the selected environment to manage its plugins.";
  if (scope.environmentIds.length !== 1 || scope.environmentIds[0] !== environmentId) {
    return "Select one owning machine to manage plugins for this scope.";
  }
  if (scope.kind === "all" || scope.kind === "environment") return { scope: "global" };
  const members = scope.members.filter((member) => member.environmentId === environmentId);
  if (members.length !== 1) return "Select one project checkout to manage its plugins.";
  const member = members[0]!;
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === member.id,
  );
  if (!project) return "The selected project is unavailable on this environment.";
  if (project.workspaceRoot !== member.workspaceRoot) {
    return "Plugins can only target the project's workspace root, not this checkout directory.";
  }
  return { scope: "project", projectId: project.id };
}
