export const PI_PACKAGE_NATIVE_SOURCE = String.raw`
const { pathToFileURL } = await import("node:url");
const { join } = await import("node:path");
const input = JSON.parse(process.argv[1]);
if (input.action && (typeof input.source !== "string" || !input.source.trim() || /^-|^(?:npm|git):\s*(?:-|$)|[\u0000-\u001f]/u.test(input.source))) {
  throw new Error("Invalid package source.");
}
const load = (relative) => import(pathToFileURL(join(input.sdkRoot, relative)).href);
const { SettingsManager, FileSettingsStorage } = await load("dist/core/settings-manager.js");
const { DefaultPackageManager } = await load("dist/core/package-manager.js");
const { isLocalPath, resolvePath } = await load("dist/utils/paths.js");
const storage = new FileSettingsStorage(input.cwd, input.agentDir);
const scopedStorage = {
  withLock(scope, change) {
    if (scope === "project" && input.scope === "global") {
      change(undefined);
      return;
    }
    storage.withLock(scope, (current) => {
      if (scope === "global" && input.scope === "project") {
        const settings = current ? JSON.parse(current.replace(/^\uFEFF/, "")) : {};
        delete settings.packages;
        change(JSON.stringify(settings));
        return undefined;
      }
      return change(current);
    });
  },
};
const settingsManager = SettingsManager.fromStorage(scopedStorage, {
  projectTrusted: input.scope === "project",
});
const errors = settingsManager.drainErrors();
if (errors.length) throw new Error(errors.map((entry) => entry.error.message).join("; "));
const manager = new DefaultPackageManager({ cwd: input.cwd, agentDir: input.agentDir, settingsManager });
let mutationSource = input.source;
if (input.action === "remove" || input.action === "update") {
  const nativeScope = input.scope === "global" ? "user" : "project";
  const baseDir = input.scope === "global" ? input.agentDir : join(input.cwd, ".pi");
  const configured = manager.listConfiguredPackages().filter((entry) => entry.scope === nativeScope);
  const selected = configured.find((entry) => entry.source === input.source) ?? configured.find((entry) =>
    isLocalPath(entry.source) && isLocalPath(input.source) &&
    resolvePath(entry.source, baseDir, { trim: true }) === resolvePath(input.source, input.cwd, { trim: true })
  );
  if (!selected) throw new Error("No matching package found in the selected scope.");
  mutationSource = isLocalPath(selected.source) ? resolvePath(selected.source, baseDir, { trim: true }) : selected.source;
}
if (input.action === "install") {
  await manager.installAndPersist(input.source, { local: input.scope === "project" });
} else if (input.action === "remove") {
  if (!await manager.removeAndPersist(mutationSource, { local: input.scope === "project" })) {
    throw new Error("No matching package found in the selected scope.");
  }
} else if (input.action === "update") {
  if (!input.source) throw new Error("A package source is required for targeted updates.");
  await manager.update(mutationSource);
}
await settingsManager.flush();
const writeErrors = settingsManager.drainErrors();
if (writeErrors.length) throw new Error(writeErrors.map((entry) => entry.error.message).join("; "));
const packages = manager.listConfiguredPackages().map((entry) => ({
  source: entry.source,
  scope: entry.scope === "user" ? "global" : "project",
  filtered: entry.filtered,
  ...(entry.installedPath ? { installedPath: entry.installedPath } : {}),
})).filter((entry) => entry.scope === input.scope);
console.log("T3_PI_PACKAGES:" + JSON.stringify({ packages, scopeLabel: input.scopeLabel }));
`;
