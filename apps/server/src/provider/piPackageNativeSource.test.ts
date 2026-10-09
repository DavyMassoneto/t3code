import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PiPackageListResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";
import { spawnAndCollect } from "./providerSnapshot.ts";
import { PI_PACKAGE_NATIVE_SOURCE } from "./piPackageNativeSource.ts";

const sdkRoot = process.env.PI_PACKAGE_TEST_SDK_ROOT;
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeList = Schema.decodeUnknownSync(Schema.fromJsonString(PiPackageListResult));

describe.skipIf(!sdkRoot)("native Pi package SDK isolated fixtures", () => {
  for (const scope of ["global", "project"] as const) {
    it.effect(
      `${scope} install, targeted update, list and removal leave the other scope untouched`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-package-native-" });
          const agentDir = path.join(root, "agent");
          const projectDir = path.join(root, "project");
          const localPackage = path.join(root, "local-package");
          yield* fs.makeDirectory(agentDir);
          yield* fs.makeDirectory(path.join(projectDir, ".pi"), { recursive: true });
          yield* fs.makeDirectory(localPackage);
          yield* fs.writeFileString(
            path.join(agentDir, "trust.json"),
            encodeJson({ [projectDir]: true }),
          );
          yield* fs.writeFileString(
            path.join(localPackage, "package.json"),
            '{"name":"test-local-pi-package","version":"1.0.0","pi":{"extensions":[]}}',
          );
          const globalPath = path.join(agentDir, "settings.json");
          const projectPath = path.join(projectDir, ".pi", "settings.json");
          const selectedPath = scope === "global" ? globalPath : projectPath;
          const counterpart = scope === "global" ? projectPath : globalPath;
          yield* fs.writeFileString(
            globalPath,
            encodeJson({
              packages: [{ source: path.relative(agentDir, localPackage), extensions: [] }],
              unchanged: "global",
            }),
          );
          yield* fs.writeFileString(
            projectPath,
            encodeJson({
              packages: [
                {
                  source: path.relative(path.join(projectDir, ".pi"), localPackage),
                  extensions: [],
                },
              ],
              unchanged: "project",
            }),
          );
          const before = yield* fs.readFileString(counterpart);
          const run = Effect.fnUntraced(function* (
            action?: "install" | "remove" | "update",
            source = localPackage,
            expectSuccess = true,
          ) {
            const payload = encodeJson({
              sdkRoot,
              cwd: projectDir,
              agentDir,
              scope,
              scopeLabel: "fixture",
              ...(action ? { action, source } : {}),
            });
            const script = expectSuccess
              ? PI_PACKAGE_NATIVE_SOURCE
              : PI_PACKAGE_NATIVE_SOURCE.replace(
                  "const manager = new DefaultPackageManager",
                  'DefaultPackageManager.prototype.removeAndPersist = async () => { throw new Error("DESTRUCTIVE_CALL"); }; DefaultPackageManager.prototype.update = async () => { throw new Error("DESTRUCTIVE_CALL"); }; const manager = new DefaultPackageManager',
                );
            const result = yield* spawnAndCollect(
              process.execPath,
              ChildProcess.make(process.execPath, ["--input-type=module", "-e", script, payload], {
                cwd: projectDir,
                env: {
                  ...process.env,
                  PI_CODING_AGENT_DIR: agentDir,
                  HOME: root,
                  USERPROFILE: root,
                  npm_config_prefix: path.join(root, "npm"),
                },
                forceKillAfter: "2 seconds",
              }),
            ).pipe(Effect.timeout("20 seconds"));
            expect(yield* fs.readFileString(counterpart)).toBe(before);
            if (!expectSuccess) {
              expect(result.code).not.toBe(0);
              expect(result.stderr).not.toContain("DESTRUCTIVE_CALL");
              return { packages: [], scopeLabel: "denied" } satisfies PiPackageListResult;
            }
            expect(result.code).toBe(0);
            return yield* Effect.try(() =>
              decodeList(
                result.stdout
                  .split(/\r?\n/u)
                  .findLast((line) => line.startsWith("T3_PI_PACKAGES:"))
                  ?.slice("T3_PI_PACKAGES:".length) ?? "",
              ),
            );
          });
          const listed = yield* run();
          expect(listed.packages).toHaveLength(1);
          const configuredSource = listed.packages[0]?.source ?? "";
          expect(listed.packages[0]).toMatchObject({
            scope,
            filtered: true,
            installedPath: localPackage,
          });
          expect(configuredSource).not.toBe(localPackage);
          yield* run("update", configuredSource);
          expect((yield* run("remove", configuredSource)).packages).toEqual([]);
          const selectedBeforeDenied = yield* fs.readFileString(selectedPath);
          yield* run("remove", configuredSource, false);
          yield* run("update", configuredSource, false);
          yield* run("remove", "npm:--global", false);
          expect(yield* fs.readFileString(selectedPath)).toBe(selectedBeforeDenied);
          const installed = yield* run("install");
          expect(installed.packages).toHaveLength(1);
          const installedSource = installed.packages[0]?.source ?? "";
          yield* run("update", installedSource);
          expect((yield* run("remove", installedSource)).packages).toEqual([]);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
});
