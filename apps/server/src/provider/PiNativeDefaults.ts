import * as NodeURL from "node:url";
import {
  type ModelSelection,
  PiSettings,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expandHomePathWith } from "../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { resolveNativePiAgentDirectory } from "./nativePiAgentDirectory.ts";
import { resolveNativePiSdkRoot } from "./nativePiSdkRoot.ts";

const decodePiSettings = Schema.decodeUnknownEffect(PiSettings);
const decodeNativeTrust = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const nativeReadInput = Schema.fromJsonString(
  Schema.Struct({
    settings: ServerSettings,
    workspaces: Schema.Record(Schema.String, Schema.String),
  }),
);
const decodeNativeReadInput = Schema.decodeUnknownEffect(nativeReadInput);
const encodeNativeReadInput = Schema.encodeEffect(nativeReadInput);

type NativeSettings = Record<string, unknown>;
type NativeScope = "global" | "project";
export interface NativeSettingsStorage {
  withLock(scope: NativeScope, change: (current: string | undefined) => string | undefined): void;
}
export interface NativeSettingsManager {
  getGlobalSettings(): NativeSettings;
  getProjectSettings(): NativeSettings;
  setDefaultModelAndProvider(provider: string | undefined, model: string | undefined): void;
  flush(): Promise<void>;
  drainErrors(): ReadonlyArray<{ readonly error: Error }>;
}
export interface NativeSettingsSdk {
  readonly FileSettingsStorage: new (cwd: string, agentDir: string) => NativeSettingsStorage;
  readonly SettingsManager: {
    fromStorage(
      storage: NativeSettingsStorage,
      options: { projectTrusted: boolean },
    ): NativeSettingsManager;
  };
}

export async function manageNativeDefaults(input: {
  readonly sdk: NativeSettingsSdk;
  readonly cwd: string;
  readonly agentDir: string;
  readonly scope: NativeScope;
  readonly projectTrusted?: boolean;
  readonly write?: { readonly model: string | null };
}): Promise<{ readonly global: NativeSettings; readonly project: NativeSettings }> {
  const storage = new input.sdk.FileSettingsStorage(input.cwd, input.agentDir);
  const selectedStorage: NativeSettingsStorage =
    input.write || input.scope === "global"
      ? {
          withLock(scope, change) {
            if (scope === "project") {
              change(undefined);
              return;
            }
            storage.withLock(input.scope, change);
          },
        }
      : storage;
  const manager = input.sdk.SettingsManager.fromStorage(selectedStorage, {
    projectTrusted: input.projectTrusted ?? true,
  });
  const checkErrors = () => {
    if (manager.drainErrors().length > 0)
      throw new Error("Native Pi settings could not be persisted or read.");
  };
  checkErrors();
  if (input.write) {
    const model = input.write.model;
    const separator = model?.indexOf("/") ?? -1;
    if (
      model !== null &&
      (separator <= 0 || separator === model.length - 1 || model === "default")
    ) {
      throw new Error("Select a real Pi provider/model.");
    }
    manager.setDefaultModelAndProvider(
      model === null ? undefined : model.slice(0, separator),
      model === null ? undefined : model.slice(separator + 1),
    );
    await manager.flush();
    checkErrors();
  }
  return { global: manager.getGlobalSettings(), project: manager.getProjectSettings() };
}

export type NativeDefaultsWorkspaces = Readonly<Record<string, string>>;

export class PiNativeDefaults extends Context.Service<
  PiNativeDefaults,
  {
    readonly invalidate: Effect.Effect<void>;
    readonly read: (
      settings: ServerSettings,
      workspaces: NativeDefaultsWorkspaces,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly write: (
      settings: ServerSettings,
      patch: ServerSettingsPatch,
      workspaces: NativeDefaultsWorkspaces,
    ) => Effect.Effect<void, ServerSettingsError>;
  }
>()("t3/provider/PiNativeDefaults") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const executable = yield* SpawnExecutableResolution;
  const isPi = (settings: ServerSettings, selection: ModelSelection | null | undefined) => {
    if (!selection) return false;
    const instance = settings.providerInstances[selection.instanceId];
    return instance ? instance.driver === "pi" : selection.instanceId === "pi";
  };
  const globalSelection = (settings: ServerSettings): ModelSelection | null => {
    if (settings.defaultModelSelection) return settings.defaultModelSelection;
    const instanceId = ProviderInstanceId.make("pi");
    const instance = settings.providerInstances[instanceId];
    if (instance && (instance.driver !== "pi" || !resolveProviderInstanceEnabled(instance)))
      return null;
    if (!instance && !settings.providers.pi.enabled) return null;
    return { instanceId, model: "default" };
  };
  const run = Effect.fnUntraced(function* (
    settings: ServerSettings,
    selection: ModelSelection,
    cwd: string,
    scope: NativeScope,
    write?: { readonly model: string | null },
  ) {
    const instance = settings.providerInstances[selection.instanceId];
    if (instance && !resolveProviderInstanceEnabled(instance)) {
      if (write)
        return yield* new ServerSettingsError({
          settingsPath: "Pi native settings",
          operation: "write-file",
        });
      return undefined;
    }
    const config = yield* decodePiSettings(instance?.config ?? settings.providers.pi);
    const environment = mergeProviderInstanceEnvironment(instance?.environment);
    const agentDir = yield* Effect.try(() =>
      resolveNativePiAgentDirectory({
        environment,
        platform,
        fallbackHome: expandHomePathWith("~", path),
        path,
      }),
    );
    const sdkRoot = yield* resolveNativePiSdkRoot({
      binaryPath: config.binaryPath,
      environment,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(SpawnExecutableResolution, executable),
    );
    if (!sdkRoot) {
      if (write)
        return yield* new ServerSettingsError({
          settingsPath: "Pi native settings",
          operation: "write-file",
        });
      return undefined;
    }
    let projectTrusted = false;
    if (scope === "project") {
      cwd = yield* fs.realPath(cwd);
      const trust = yield* fs
        .readFileString(path.join(agentDir, "trust.json"))
        .pipe(Effect.orElseSucceed(() => "{}"));
      const entries = yield* decodeNativeTrust(trust.replace(/^\uFEFF/u, ""));
      const trusted = yield* Effect.try(() => {
        if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
        let ancestor = cwd;
        while (true) {
          const value = Reflect.get(entries, ancestor);
          if (typeof value === "boolean") return value;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) return false;
          ancestor = parent;
        }
      });
      projectTrusted = trusted;
      if (write && !trusted)
        return yield* new ServerSettingsError({
          settingsPath: "Pi project trust",
          operation: "write-file",
        });
    }
    const modulePath = yield* fs.realPath(
      path.join(sdkRoot, "dist", "core", "settings-manager.js"),
    );
    const relativeModule = path.relative(sdkRoot, modulePath);
    if (
      path.isAbsolute(relativeModule) ||
      relativeModule === ".." ||
      relativeModule.startsWith(`..${path.sep}`)
    ) {
      return yield* new ServerSettingsError({
        settingsPath: "Pi native SDK",
        operation: "read-file",
      });
    }
    return yield* Effect.tryPromise(async () => {
      const sdk = (await import(NodeURL.pathToFileURL(modulePath).href)) as NativeSettingsSdk;
      return manageNativeDefaults({
        sdk,
        agentDir,
        cwd,
        scope,
        projectTrusted,
        ...(write ? { write } : {}),
      });
    });
  });
  const failure = (operation: "read-file" | "write-file") => (cause: unknown) =>
    new ServerSettingsError({ settingsPath: "Pi native settings", operation, cause });
  const fromNative = (
    selection: ModelSelection,
    native: NativeSettings,
  ): ModelSelection | undefined => {
    const provider = native.defaultProvider;
    const model = native.defaultModel;
    return typeof provider === "string" &&
      provider.length > 0 &&
      typeof model === "string" &&
      model.length > 0
      ? selection.model === `${provider}/${model}`
        ? selection
        : { instanceId: selection.instanceId, model: `${provider}/${model}` }
      : undefined;
  };
  const readUncached = (settings: ServerSettings, workspaces: NativeDefaultsWorkspaces) =>
    Effect.gen(function* () {
      const selected = globalSelection(settings);
      let defaultModelSelection = settings.defaultModelSelection;
      const projectSettingsOverrides = { ...settings.projectSettingsOverrides };
      if (selected && isPi(settings, selected)) {
        const native = yield* run(settings, selected, expandHomePathWith("~", path), "global");
        if (native) defaultModelSelection = fromNative(selected, native.global) ?? null;
      }
      for (const [projectId, workspace] of Object.entries(workspaces)) {
        const overrides =
          settings.projectSettingsOverrides[
            projectId as keyof typeof settings.projectSettingsOverrides
          ];
        const projectSelection = overrides?.defaultModelSelection;
        const target = projectSelection ?? selected;
        if (!target || !isPi(settings, target)) continue;
        const native = yield* run(settings, target, workspace, "project");
        if (!native) continue;
        const actual = fromNative(target, { ...native.global, ...native.project });
        const hasNativeOverride =
          "defaultProvider" in native.project || "defaultModel" in native.project;
        if (hasNativeOverride && actual) {
          projectSettingsOverrides[projectId as keyof typeof projectSettingsOverrides] = {
            ...overrides,
            defaultModelSelection: actual,
          };
        } else if (isPi(settings, projectSelection)) {
          const { defaultModelSelection: _defaultModelSelection, ...rest } = overrides!;
          projectSettingsOverrides[projectId as keyof typeof projectSettingsOverrides] = rest;
        }
      }
      return { ...settings, defaultModelSelection, projectSettingsOverrides };
    }).pipe(Effect.mapError(failure("read-file")));
  const readCache = yield* Cache.makeWith<string, ServerSettings, ServerSettingsError>(
    (key) =>
      decodeNativeReadInput(key).pipe(
        Effect.mapError(failure("read-file")),
        Effect.flatMap(({ settings, workspaces }) => readUncached(settings, workspaces)),
      ),
    {
      capacity: 8,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero),
    },
  );
  const invalidate = Cache.invalidateAll(readCache);
  const read = (settings: ServerSettings, workspaces: NativeDefaultsWorkspaces) =>
    encodeNativeReadInput({ settings, workspaces }).pipe(
      Effect.mapError(failure("read-file")),
      Effect.flatMap((key) => Cache.get(readCache, key)),
    );
  const write = (
    settings: ServerSettings,
    patch: ServerSettingsPatch,
    workspaces: NativeDefaultsWorkspaces,
  ) =>
    Effect.gen(function* () {
      const selection = patch.defaultModelSelection;
      if (
        selection &&
        isPi(settings, selection) &&
        selection.model !== "default" &&
        (selection.instanceId !== settings.defaultModelSelection?.instanceId ||
          selection.model !== settings.defaultModelSelection?.model)
      ) {
        yield* run(settings, selection, expandHomePathWith("~", path), "global", {
          model: selection.model,
        });
      }
      for (const [projectId, overrides] of Object.entries(patch.projectSettingsOverrides ?? {})) {
        const previous =
          settings.projectSettingsOverrides[
            projectId as keyof typeof settings.projectSettingsOverrides
          ]?.defaultModelSelection;
        const next = overrides?.defaultModelSelection;
        const target =
          next && isPi(settings, next) ? next : isPi(settings, previous) ? previous : null;
        if (!target) continue;
        if (
          next &&
          previous &&
          next.instanceId === previous.instanceId &&
          next.model === previous.model
        )
          continue;
        const workspace = workspaces[projectId];
        if (!workspace)
          return yield* new ServerSettingsError({
            settingsPath: "Pi project settings",
            operation: "write-file",
          });
        if (next?.model === "default") continue;
        yield* run(settings, target, workspace, "project", {
          model: next && isPi(settings, next) ? next.model : null,
        });
      }
    }).pipe(Effect.mapError(failure("write-file")), Effect.ensuring(invalidate));
  return PiNativeDefaults.of({ read, write, invalidate });
});

export const layer = Layer.effect(PiNativeDefaults, make);
