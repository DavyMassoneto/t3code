import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  make,
  manageNativeDefaults,
  type NativeSettingsSdk,
  type NativeSettingsStorage,
} from "./PiNativeDefaults.ts";

const sdkRoot = process.env.T3_PI_TEST_SDK_ROOT;
const nativeTest = sdkRoot ? it.effect : it.effect.skip;
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeUnknownEffect(ServerSettings);

describe("Pi native defaults", () => {
  it("rejects synthetic defaults before writing", async () => {
    let writes = 0;
    const sdk: NativeSettingsSdk = {
      FileSettingsStorage: class {
        withLock() {
          writes += 1;
        }
      },
      SettingsManager: {
        fromStorage: () => ({
          getGlobalSettings: () => ({}),
          getProjectSettings: () => ({}),
          setDefaultModelAndProvider: () => {
            writes += 1;
          },
          flush: async () => {},
          drainErrors: () => [],
        }),
      },
    };
    await expect(
      manageNativeDefaults({
        sdk,
        cwd: "unused",
        agentDir: "unused",
        scope: "global",
        write: { model: "default" },
      }),
    ).rejects.toThrow("real Pi");
    expect(writes).toBe(0);
  });

  nativeTest("uses the installed SDK with isolated profiles and exact workspace scopes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-native-defaults-" });
      const sdk = yield* Effect.promise(
        async () =>
          import(
            NodeURL.pathToFileURL(path.join(sdkRoot!, "dist/core/settings-manager.js")).href
          ) as Promise<NativeSettingsSdk>,
      );
      const agentA = path.join(root, "agent-a");
      const agentB = path.join(root, "agent-b");
      const workspaceA = path.join(root, "workspace-a");
      const workspaceB = path.join(root, "workspace-ab");
      for (const directory of [
        agentA,
        agentB,
        workspaceA,
        workspaceB,
        path.join(workspaceA, ".pi"),
        path.join(workspaceB, ".pi"),
      ]) {
        yield* fs.makeDirectory(directory, { recursive: true });
      }
      const globalA = path.join(agentA, "settings.json");
      const globalB = path.join(agentB, "settings.json");
      const projectA = path.join(workspaceA, ".pi/settings.json");
      const projectB = path.join(workspaceB, ".pi/settings.json");
      const unrelated = {
        packages: ["npm:fixture"],
        compaction: { enabled: false },
        custom: { retained: [1, 2] },
      };
      yield* fs.writeFileString(
        globalA,
        encodeJson({ ...unrelated, defaultProvider: "anthropic", defaultModel: "opus" }),
      );
      yield* fs.writeFileString(
        globalB,
        encodeJson({ ...unrelated, defaultProvider: "openai", defaultModel: "gpt" }),
      );
      yield* fs.writeFileString(
        projectA,
        encodeJson({ ...unrelated, defaultProvider: "anthropic", defaultModel: "project-opus" }),
      );
      yield* fs.writeFileString(projectB, encodeJson({ untouched: true }));
      for (const agentDir of [agentA, agentB]) {
        yield* fs.writeFileString(
          path.join(agentDir, "trust.json"),
          encodeJson({ [workspaceA]: true, [workspaceB]: true }),
        );
      }
      const originalA = yield* fs.readFileString(globalA);
      const originalProjectB = yield* fs.readFileString(projectB);
      yield* Effect.promise(() =>
        manageNativeDefaults({
          sdk,
          agentDir: agentB,
          cwd: workspaceA,
          scope: "global",
          write: { model: "openai/new/model" },
        }),
      );
      expect(decodeJson(yield* fs.readFileString(globalB))).toEqual({
        ...unrelated,
        defaultProvider: "openai",
        defaultModel: "new/model",
      });
      expect(yield* fs.readFileString(globalA)).toBe(originalA);
      const originalB = yield* fs.readFileString(globalB);
      yield* Effect.promise(() =>
        manageNativeDefaults({
          sdk,
          agentDir: agentB,
          cwd: workspaceA,
          scope: "project",
          write: { model: "google/gemini" },
        }),
      );
      expect(decodeJson(yield* fs.readFileString(projectA))).toEqual({
        ...unrelated,
        defaultProvider: "google",
        defaultModel: "gemini",
      });
      expect(yield* fs.readFileString(globalB)).toBe(originalB);
      expect(yield* fs.readFileString(projectB)).toBe(originalProjectB);
      yield* Effect.promise(() =>
        manageNativeDefaults({
          sdk,
          agentDir: agentB,
          cwd: workspaceA,
          scope: "project",
          write: { model: null },
        }),
      );
      expect(decodeJson(yield* fs.readFileString(projectA))).toEqual(unrelated);
      expect(yield* fs.readFileString(globalA)).toBe(originalA);
      expect(yield* fs.readFileString(globalB)).toBe(originalB);

      const failingSdk: NativeSettingsSdk = {
        ...sdk,
        FileSettingsStorage: class extends sdk.FileSettingsStorage {
          override withLock(
            scope: Parameters<NativeSettingsStorage["withLock"]>[0],
            change: Parameters<NativeSettingsStorage["withLock"]>[1],
          ) {
            super.withLock(scope, (current) => {
              const next = change(current);
              if (next !== undefined) throw new Error("fixture write denied");
              return next;
            });
          }
        },
      };
      const failed = yield* Effect.tryPromise(() =>
        manageNativeDefaults({
          sdk: failingSdk,
          agentDir: agentB,
          cwd: workspaceA,
          scope: "global",
          write: { model: "openai/denied" },
        }),
      ).pipe(Effect.flip);
      expect(failed).toBeDefined();
      expect(yield* fs.readFileString(globalB)).toBe(originalB);
      yield* fs.writeFileString(globalB, "{broken");
      yield* Effect.tryPromise(() =>
        manageNativeDefaults({
          sdk,
          agentDir: agentB,
          cwd: workspaceA,
          scope: "global",
          write: { model: "openai/denied" },
        }),
      ).pipe(Effect.flip);
      expect(yield* fs.readFileString(globalB)).toBe("{broken");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  nativeTest(
    "reads native truth, bounds lock scans, refreshes external changes, and clears project overrides",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-default-service-" });
        const nativeModule = NodeURL.pathToFileURL(
          path.join(sdkRoot!, "dist/core/settings-manager.js"),
        ).href;
        const fixtureRoot = path.join(root, "sdk");
        const binary = path.join(fixtureRoot, "dist/cli.js");
        yield* fs.makeDirectory(path.join(fixtureRoot, "dist/core"), { recursive: true });
        yield* fs.writeFileString(
          path.join(fixtureRoot, "package.json"),
          encodeJson({
            name: "@earendil-works/pi-coding-agent",
            type: "module",
            bin: { pi: "dist/cli.js" },
          }),
        );
        yield* fs.writeFileString(binary, "");
        for (const module of ["auth-storage.js", "model-runtime.js"])
          yield* fs.writeFileString(path.join(fixtureRoot, "dist/core", module), "");
        yield* fs.writeFileString(
          path.join(fixtureRoot, "dist/core/settings-manager.js"),
          `export { SettingsManager, FileSettingsStorage } from ${encodeJson(nativeModule)};`,
        );
        const agentDir = path.join(root, "agent");
        const workspace = path.join(root, "workspace");
        yield* fs.makeDirectory(agentDir);
        yield* fs.makeDirectory(path.join(workspace, ".pi"), { recursive: true });
        yield* fs.writeFileString(
          path.join(agentDir, "trust.json"),
          encodeJson({ [workspace]: true }),
        );
        const globalPath = path.join(agentDir, "settings.json");
        const projectPath = path.join(workspace, ".pi/settings.json");
        yield* fs.writeFileString(
          globalPath,
          encodeJson({ defaultProvider: "anthropic", defaultModel: "opus", packages: ["fixture"] }),
        );
        yield* fs.writeFileString(
          projectPath,
          encodeJson({ defaultProvider: "google", defaultModel: "gemini", theme: "dark" }),
        );
        const instanceId = ProviderInstanceId.make("native-profile");
        const settings = yield* decodeSettings({
          defaultModelSelection: {
            instanceId,
            model: "openai/stale",
            options: [{ id: "thinkingLevel", value: "high" }],
          },
          providerInstances: {
            [instanceId]: {
              driver: "pi",
              enabled: true,
              config: { binaryPath: binary },
              environment: [{ name: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false }],
            },
          },
        });
        let sdkResolutions = 0;
        const service = yield* make.pipe(
          Effect.provideService(HostProcessPlatform, path.sep === "\\" ? "win32" : "linux"),
          Effect.provideService(SpawnExecutableResolution, () => {
            sdkResolutions += 1;
            return binary;
          }),
        );
        const workspaces = { project: workspace };
        const initial = yield* service.read(settings, workspaces);
        expect(initial.defaultModelSelection).toEqual({ instanceId, model: "anthropic/opus" });
        expect(
          initial.projectSettingsOverrides[
            "project" as keyof typeof initial.projectSettingsOverrides
          ]?.defaultModelSelection,
        ).toEqual({ instanceId, model: "google/gemini" });
        const resolutionsAfterRead = sdkResolutions;
        yield* service.read(settings, workspaces);
        expect(sdkResolutions).toBe(resolutionsAfterRead);
        const sameModelSelection = { ...settings.defaultModelSelection!, model: "anthropic/opus" };
        const sameModel = yield* service.read(
          { ...settings, defaultModelSelection: sameModelSelection },
          workspaces,
        );
        expect(sameModel.defaultModelSelection).toEqual(sameModelSelection);
        yield* fs.writeFileString(
          globalPath,
          encodeJson({
            defaultProvider: "openai",
            defaultModel: "external",
            packages: ["fixture"],
          }),
        );
        yield* service.invalidate;
        const refreshed = yield* service.read(settings, workspaces);
        expect(refreshed.defaultModelSelection).toEqual({ instanceId, model: "openai/external" });
        yield* service.write(
          refreshed,
          { projectSettingsOverrides: { project: { defaultAutoPull: true } } } as Parameters<
            typeof service.write
          >[1],
          workspaces,
        );
        expect(decodeJson(yield* fs.readFileString(projectPath))).toEqual({ theme: "dark" });
        const cleared = yield* service.read(settings, workspaces);
        expect(
          cleared.projectSettingsOverrides[
            "project" as keyof typeof cleared.projectSettingsOverrides
          ]?.defaultModelSelection,
        ).toBeUndefined();
        yield* service.write(
          cleared,
          { defaultModelSelection: { instanceId, model: "anthropic/new" } },
          workspaces,
        );
        expect(decodeJson(yield* fs.readFileString(globalPath))).toEqual({
          defaultProvider: "anthropic",
          defaultModel: "new",
          packages: ["fixture"],
        });
        const globalBeforeReset = yield* fs.readFileString(globalPath);
        yield* service.write(cleared, { defaultModelSelection: null }, workspaces);
        expect(yield* fs.readFileString(globalPath)).toBe(globalBeforeReset);
        yield* service.write(
          cleared,
          { defaultModelSelection: { instanceId, model: "default" } },
          workspaces,
        );
        expect(yield* fs.readFileString(globalPath)).toBe(globalBeforeReset);
        yield* fs.writeFileString(
          path.join(agentDir, "trust.json"),
          encodeJson({ [workspace]: false }),
        );
        const untrusted = yield* service
          .write(
            cleared,
            {
              projectSettingsOverrides: {
                project: { defaultModelSelection: { instanceId, model: "openai/blocked" } },
              },
            } as Parameters<typeof service.write>[1],
            workspaces,
          )
          .pipe(Effect.flip);
        expect(untrusted._tag).toBe("ServerSettingsError");
        expect(decodeJson(yield* fs.readFileString(projectPath))).toEqual({ theme: "dark" });
        yield* TestClock.adjust("31 seconds");
        yield* service.read(settings, workspaces);
        expect(sdkResolutions).toBeGreaterThan(resolutionsAfterRead);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
