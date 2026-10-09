import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, type Project } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PiPackages from "./PiPackages.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("Pi package storage locks", () => {
  it.effect(
    "serializes one project across instances with different agent homes and rejects relative homes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-package-locks-" });
        const cwd = path.join(root, "project");
        const agentA = path.join(root, "agent-a");
        const agentB = path.join(root, "agent-b");
        const binary = path.join(root, "cli.js");
        const managerPath = path.join(root, "dist", "core", "package-manager.js");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(path.dirname(managerPath), { recursive: true });
        yield* fs.writeFileString(managerPath, "fixture");
        const canonicalManagerPath = yield* fs.realPath(managerPath);
        yield* fs.writeFileString(binary, "fixture");
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({
            name: "@earendil-works/pi-coding-agent",
            bin: { pi: "cli.js" },
          }),
        );
        for (const module of ["auth-storage.js", "model-runtime.js"])
          yield* fs.writeFileString(path.join(root, "dist", "core", module), "fixture");
        for (const agentDir of [agentA, agentB]) {
          yield* fs.makeDirectory(agentDir);
          yield* fs.writeFileString(path.join(agentDir, "trust.json"), encodeJson({ [cwd]: true }));
        }
        const instanceA = ProviderInstanceId.make("packages-a");
        const instanceB = ProviderInstanceId.make("packages-b");
        const relativeInstance = ProviderInstanceId.make("packages-relative");
        const projectId = ProjectId.make("packages-shared-project");
        const firstStarted = yield* Deferred.make<void>();
        const secondResolved = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        let sdkResolutions = 0;
        const fsWithSignal = {
          ...fs,
          realPath: (filename: string) =>
            fs.realPath(filename).pipe(
              Effect.tap((resolvedPath) => {
                if (resolvedPath !== canonicalManagerPath) return Effect.void;
                sdkResolutions += 1;
                return sdkResolutions === 2
                  ? Deferred.succeed(secondResolved, undefined)
                  : Effect.void;
              }),
            ),
        };
        const launches: ChildProcess.Command[] = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            launches.push(command);
            const first = launches.length === 1;
            if (first) yield* Deferred.succeed(firstStarted, undefined);
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(900_000_001),
              exitCode: (first ? Deferred.await(releaseFirst) : Effect.void).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.succeed(
                new TextEncoder().encode('T3_PI_PACKAGES:{"packages":[],"scopeLabel":"fixture"}\n'),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const instanceConfig = (agentDir: string) => ({
          driver: "pi" as const,
          config: {},
          environment: [{ name: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false }],
        });
        const service = yield* PiPackages.PiPackages.pipe(
          Effect.provide(
            Layer.provide(
              PiPackages.layer,
              Layer.mergeAll(
                ServerConfig.layerTest(root, path.join(root, "t3")),
                ServerSettings.layerTest({
                  providerInstances: {
                    [instanceA]: instanceConfig(agentA),
                    [instanceB]: instanceConfig(agentB),
                    [relativeInstance]: instanceConfig(".pi-relative"),
                  },
                }),
                Layer.succeed(ProjectService.ProjectService, {
                  getById: () => Effect.succeedSome({ workspaceRoot: cwd } as Project),
                } as unknown as ProjectService.ProjectService["Service"]),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => Effect.die("Catalog should not be accessed")),
                ),
                Layer.succeed(HostProcessPlatform, "linux"),
                Layer.succeed(SpawnExecutableResolution, () => binary),
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              ).pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fsWithSignal))),
            ),
          ),
        );
        const mutate = (instanceId: ProviderInstanceId) =>
          service.mutate({
            instanceId,
            scope: "project",
            projectId,
            action: "install",
            source: "npm:test-fixture",
            consent: true,
          });
        const first = yield* mutate(instanceA).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        const second = yield* mutate(instanceB).pipe(Effect.forkChild);
        yield* Deferred.await(secondResolved);
        yield* Effect.yieldNow;
        expect(launches).toHaveLength(1);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.joinAll([first, second]);
        expect(launches).toHaveLength(2);
        for (const launch of launches) {
          if (ChildProcess.isStandardCommand(launch))
            expect(launch.options.forceKillAfter).toBe("2 seconds");
        }
        expect(
          (yield* service.list({ instanceId: relativeInstance, scope: "global" }).pipe(Effect.flip))
            .message,
        ).toContain("Relative PI_CODING_AGENT_DIR");
        expect(
          (yield* service
            .list({ instanceId: relativeInstance, scope: "project", projectId })
            .pipe(Effect.flip)).message,
        ).toContain("Relative PI_CODING_AGENT_DIR");
        expect(launches).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
