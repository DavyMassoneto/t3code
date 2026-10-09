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
import * as Scheduler from "effect/Scheduler";
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
  it.effect.each(["filesystem", "aliased"])(
    "serializes one project across instances with different agent homes and rejects relative homes (%s)",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-package-locks-" });
        const root = path.join(directory, "private", "var");
        yield* fs.makeDirectory(root, { recursive: true });
        const cwd = path.join(root, "project");
        const agentA = path.join(root, "agent-a");
        const agentB = path.join(root, "agent-b");
        const binary = path.join(root, "cli.js");
        const managerPath = path.join(root, "dist", "core", "package-manager.js");
        const aliasPath = (filename: string) =>
          fixture === "aliased"
            ? path.join(directory, "var", path.relative(root, filename))
            : filename;
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(path.dirname(managerPath), { recursive: true });
        yield* fs.writeFileString(managerPath, "fixture");
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
        const canonicalCwd = yield* fs.realPath(cwd);
        for (const agentDir of [agentA, agentB]) {
          yield* fs.makeDirectory(agentDir);
          yield* fs.writeFileString(
            path.join(agentDir, "trust.json"),
            encodeJson({ [canonicalCwd]: true }),
          );
        }
        const realPaths = new Map<string, string>();
        const contents = new Map<string, string>();
        for (const filename of [
          root,
          cwd,
          agentA,
          agentB,
          binary,
          managerPath,
          path.join(root, "dist", "core", "auth-storage.js"),
          path.join(root, "dist", "core", "model-runtime.js"),
          path.join(root, "package.json"),
          path.join(agentA, "trust.json"),
          path.join(agentB, "trust.json"),
        ]) {
          const canonicalPath = yield* fs.realPath(filename);
          realPaths.set(aliasPath(filename), canonicalPath);
          realPaths.set(canonicalPath, canonicalPath);
          if (filename.endsWith(".json"))
            contents.set(canonicalPath, yield* fs.readFileString(filename));
        }
        if (fixture === "aliased") expect(aliasPath(cwd)).not.toBe(canonicalCwd);
        const lookup = (values: ReadonlyMap<string, string>, filename: string) =>
          Effect.suspend(() => {
            const value = values.get(filename);
            return value === undefined
              ? Effect.die(`Unexpected fixture filesystem access: ${filename}`)
              : Effect.succeed(value);
          });
        const fsFixture = {
          ...fs,
          exists: (filename: string) => Effect.succeed(contents.has(filename)),
          realPath: (filename: string) => lookup(realPaths, filename),
          readFileString: (filename: string) => lookup(contents, filename),
        };
        const instanceA = ProviderInstanceId.make("packages-a");
        const instanceB = ProviderInstanceId.make("packages-b");
        const relativeInstance = ProviderInstanceId.make("packages-relative");
        const projectId = ProjectId.make("packages-shared-project");
        const firstStarted = yield* Deferred.make<void>();
        const secondFinished = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
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
                    [instanceA]: instanceConfig(aliasPath(agentA)),
                    [instanceB]: instanceConfig(aliasPath(agentB)),
                    [relativeInstance]: instanceConfig(".pi-relative"),
                  },
                }),
                Layer.succeed(ProjectService.ProjectService, {
                  getById: () => Effect.succeedSome({ workspaceRoot: aliasPath(cwd) } as Project),
                } as unknown as ProjectService.ProjectService["Service"]),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => Effect.die("Catalog should not be accessed")),
                ),
                Layer.succeed(HostProcessPlatform, "linux"),
                Layer.succeed(SpawnExecutableResolution, () => aliasPath(binary)),
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              ).pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fsFixture))),
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
        yield* Deferred.await(firstStarted).pipe(Effect.raceFirst(Fiber.join(first)));
        const secondDispatcher = new Scheduler.MixedScheduler("sync").makeDispatcher();
        const second = yield* mutate(instanceB).pipe(
          Effect.onExit(() => Deferred.succeed(secondFinished, undefined)),
          Effect.provideService(Scheduler.Scheduler, {
            executionMode: "sync",
            shouldYield: () => false,
            makeDispatcher: () => secondDispatcher,
          }),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.sync(() => secondDispatcher.flush());
        if (yield* Deferred.isDone(secondFinished)) yield* Fiber.join(second);
        expect(yield* Deferred.isDone(secondFinished)).toBe(false);
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
