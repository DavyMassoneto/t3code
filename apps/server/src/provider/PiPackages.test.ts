import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, type Project } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PiPackages from "./PiPackages.ts";

const catalog =
  '<form class="packages-action-bar"></form><article data-package-card="true" data-package-name="fixture-package" data-package-types="extension skill"><a href="/packages/fixture-package" data-package-link="true">fixture-package</a><p class="packages-desc">A &amp; B</p><button data-copy-text="pi install npm:fixture-package"></button></article>';
const projectId = ProjectId.make("package-project");
const instanceId = ProviderInstanceId.make("package-instance");

describe("PiPackages", () => {
  it("projects genuine author, monthly downloads and epoch-millisecond publication metadata", () => {
    const dated = catalog
      .replace(
        'data-package-card="true"',
        'data-package-card="true" data-package-downloads="1550704" data-package-date="1791251148391"',
      )
      .replace(
        "</article>",
        '<div class="packages-meta"><span><a>nico&amp;preme</a></span><span>1.6M/mo</span><span>3d ago</span></div></article>',
      );
    const result = PiPackages.parsePiPackageCatalog(dated, "https://pi.dev/packages");
    expect(result.packages[0]).toMatchObject({
      author: "nico&preme",
      monthlyDownloads: 1550704,
      publishedAt: "2026-10-06T01:45:48.391Z",
    });
    expect(result.packages[0]).not.toHaveProperty("preview");
  });

  it("omits malformed optional metadata rather than rejecting useful gallery cards", () => {
    for (const metadata of [
      'data-package-downloads="NaN" data-package-date="invalid"',
      'data-package-downloads="-1" data-package-date="Infinity"',
      'data-package-downloads="1.5" data-package-date="9007199254740992"',
      'data-package-downloads="9007199254740992" data-package-date="8640000000000001"',
    ]) {
      const result = PiPackages.parsePiPackageCatalog(
        catalog
          .replace('data-package-card="true"', `data-package-card="true" ${metadata}`)
          .replace(
            "</article>",
            `<div class="packages-meta"><span>${"x".repeat(257)}</span></div></article>`,
          ),
        "https://pi.dev/packages",
      );
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]).not.toHaveProperty("author");
      expect(result.packages[0]).not.toHaveProperty("monthlyDownloads");
      expect(result.packages[0]).not.toHaveProperty("publishedAt");
    }
    const zero = PiPackages.parsePiPackageCatalog(
      catalog
        .replace('data-package-card="true"', 'data-package-card="true" data-package-downloads="0"')
        .replace(
          "</article>",
          '<div class="packages-meta"><span><script>doNotExport()</script> native\u0000 author </span></div></article>',
        ),
      "https://pi.dev/packages",
    );
    expect(zero.packages[0]).toMatchObject({ author: "native author", monthlyDownloads: 0 });
  });

  it("reads first, middle and partial last-page counts from genuine gallery markup", () => {
    for (const [page, range, hasNext, hasPrevious] of [
      [1, "1-50 / 5444", true, false],
      [2, "51-100 / 5444", true, true],
      [109, "5401-5444 / 5444", false, true],
    ] as const) {
      const html = `<div class="packages-count">${range}</div><nav class="pagination packages-pagination"><span aria-current="page">${page}</span><a class="pagination-page" href="/packages?page=109">109</a>${hasPrevious ? `<a class="pagination-link" href="/packages?page=${page - 1}">← Previous</a>` : ""}${hasNext ? `<a class="pagination-link" href="/packages?page=${page + 1}">Next →</a>` : ""}</nav>${catalog}`;
      expect(
        PiPackages.parsePiPackageCatalog(html, `https://pi.dev/packages?page=${page}`).pagination,
      ).toEqual({
        page,
        totalPages: 109,
        total: 5444,
        catalogTotal: 5444,
        rangeStart: page === 1 ? 1 : page === 2 ? 51 : 5401,
        rangeEnd: page === 1 ? 50 : page === 2 ? 100 : 5444,
        hasNext,
        hasPrevious,
      });
    }
    expect(
      PiPackages.parsePiPackageCatalog(
        '<div class="packages-count">0 / 5444</div><form class="packages-action-bar"></form>',
        "https://pi.dev/packages?name=no-matches",
      ).pagination,
    ).toEqual({ page: 1, total: 0, catalogTotal: 5444, hasNext: false, hasPrevious: false });
    for (const count of ["1-50 / NaN", "1-50 / 12", "50-1 / 5444", "1-50 / 9007199254740992"])
      expect(
        PiPackages.parsePiPackageCatalog(
          `<div class="packages-count">${count}</div>${catalog}`,
          "https://pi.dev/packages",
        ).pagination,
      ).toBeUndefined();
  });

  it("distinguishes filtered matches from catalog total and navigates only matching real anchors", () => {
    const filtered =
      '<div class="packages-count">1-50 / 60 (of 5444)</div><nav class="pagination packages-pagination"><span class="pagination-page is-active" aria-current="page">1</span><a class="pagination-page" href="/packages?name=pi-subagents&amp;type=extension&amp;page=2">2</a><a class="pagination-link" href="/packages?name=pi-subagents&amp;type=extension&amp;page=2">Next →</a></nav>';
    expect(
      PiPackages.parsePiPackageCatalog(
        filtered + catalog,
        "https://pi.dev/packages?name=pi-subagents&type=extension&sort=downloads",
      ).pagination,
    ).toEqual({
      page: 1,
      totalPages: 2,
      total: 60,
      catalogTotal: 5444,
      rangeStart: 1,
      rangeEnd: 50,
      hasNext: true,
      hasPrevious: false,
    });
    const last =
      '<div class="packages-count">51-60 / 60 (of 5444)</div><nav class="pagination packages-pagination"><a class="pagination-link" href="/packages?name=pi-subagents&amp;type=extension">← Previous</a><a class="pagination-page" href="/packages?name=pi-subagents&amp;type=extension">1</a><span aria-current="page">2</span></nav>';
    expect(
      PiPackages.parsePiPackageCatalog(
        last + catalog,
        "https://pi.dev/packages?name=pi-subagents&type=extension&page=2",
      ).pagination,
    ).toEqual({
      page: 2,
      totalPages: 2,
      total: 60,
      catalogTotal: 5444,
      rangeStart: 51,
      rangeEnd: 60,
      hasNext: false,
      hasPrevious: true,
    });
    for (const unsafe of [
      "https://other.invalid/packages?name=pi-subagents&type=extension&page=2",
      "https://private:secret@pi.dev/packages?name=pi-subagents&type=extension&page=2",
      "/packages?name=different&type=extension&page=2",
      "/packages?name=pi-subagents&type=theme&page=2",
      "/packages?name=pi-subagents&type=extension&sort=recent&page=2",
      "/packages?name=pi-subagents&type=extension&page=2&token=secret",
      "/packages?name=pi-subagents&type=extension&page=2&page=3",
      "/packages?name=pi-subagents&type=extension&page=109",
    ]) {
      const html = `<div class="packages-count">1-50 / 60 (of 5444)</div><nav class="packages-pagination"><a class="pagination-link" href="${unsafe.replace(/&/g, "&amp;")}">Next →</a></nav>${catalog}`;
      const pagination = PiPackages.parsePiPackageCatalog(
        html,
        "https://pi.dev/packages?name=pi-subagents&type=extension",
      ).pagination;
      expect(pagination?.hasNext).toBe(false);
      expect(pagination?.totalPages).toBeUndefined();
    }
    expect(
      PiPackages.parsePiPackageCatalog(
        '<div class="packages-count">1-10 / 10 (of 5444)</div>' + catalog,
        "https://pi.dev/packages?name=filtered",
      ).pagination,
    ).toEqual({
      page: 1,
      total: 10,
      catalogTotal: 5444,
      rangeStart: 1,
      rangeEnd: 10,
      hasNext: false,
      hasPrevious: false,
    });
  });

  it("rejects foreign, malformed and credential-bearing package links", () => {
    for (const href of [
      "https://foreign.invalid/packages/fixture",
      "https://secret:credential@pi.dev/packages/fixture",
      "http://[",
    ])
      expect(
        PiPackages.parsePiPackageCatalog(
          catalog.replace("/packages/fixture-package", href),
          "https://pi.dev/packages",
        ).packages,
      ).toEqual([]);
  });
  it("extracts only actual install commands from official gallery cards", () => {
    expect(
      PiPackages.parsePiPackageCatalog(catalog, "https://pi.dev/packages?name=fixture"),
    ).toEqual({
      catalogUrl: "https://pi.dev/packages?name=fixture",
      packages: [
        {
          name: "fixture-package",
          description: "A & B",
          source: "npm:fixture-package",
          url: "https://pi.dev/packages/fixture-package",
          types: ["extension", "skill"],
        },
      ],
    });
    expect(
      PiPackages.parsePiPackageCatalog(
        '<form class="packages-action-bar"></form>',
        "https://pi.dev/packages",
      ).packages,
    ).toEqual([]);
    expect(() =>
      PiPackages.parsePiPackageCatalog("upstream unavailable", "https://pi.dev/packages"),
    ).toThrow("unrecognized");
    expect(
      PiPackages.parsePiPackageCatalog(
        catalog.replace("npm:fixture-package", "--all"),
        "https://pi.dev/packages",
      ).packages,
    ).toEqual([]);
  });

  for (const operation of ["list", "mutate"] as const) {
    it.effect(
      `refuses untrusted project ${operation} before executable resolution or native startup`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-packages-test-" });
          const agentDir = path.join(root, "agent");
          yield* fs.makeDirectory(agentDir);
          yield* fs.writeFileString(
            path.join(agentDir, "trust.json"),
            JSON.stringify({ [root]: false }),
          );
          let started = 0;
          let resolved = 0;
          const projects = {
            getById: () => Effect.succeedSome({ workspaceRoot: root } as Project),
          } as unknown as ProjectService.ProjectService["Service"];
          const service = yield* PiPackages.PiPackages.pipe(
            Effect.provide(
              Layer.provide(
                PiPackages.layer,
                Layer.mergeAll(
                  ServerConfig.layerTest(root, path.join(root, "t3")),
                  ServerSettings.layerTest({
                    providerInstances: {
                      [instanceId]: {
                        driver: "pi",
                        config: {},
                        environment: [
                          { name: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false },
                        ],
                      },
                    },
                  }),
                  Layer.succeed(ProjectService.ProjectService, projects),
                  Layer.succeed(
                    HttpClient.HttpClient,
                    HttpClient.make((request) =>
                      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(catalog))),
                    ),
                  ),
                  Layer.succeed(SpawnExecutableResolution, () => {
                    resolved += 1;
                    return "unreachable";
                  }),
                  Layer.succeed(
                    ChildProcessSpawner.ChildProcessSpawner,
                    ChildProcessSpawner.make(() => {
                      started += 1;
                      return Effect.die("Native startup must not run");
                    }),
                  ),
                ),
              ),
            ),
          );
          const target = { instanceId, scope: "project" as const, projectId };
          const result = yield* (
            operation === "list"
              ? service.list(target)
              : service.mutate({
                  ...target,
                  source: "npm:test-fixture",
                  action: "install",
                  consent: true,
                })
          ).pipe(Effect.flip);
          expect(result.message).toContain("saved Pi project trust");
          expect(resolved).toBe(0);
          expect(started).toBe(0);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }

  it.effect("lists through the instance's native SDK with explicit directory and destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-packages-test-" });
      const binary = path.join(root, "pi");
      const agentDir = path.join(root, "instance-agent");
      yield* fs.writeFileString(binary, "fixture");
      yield* fs.makeDirectory(path.join(root, "dist", "core"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "dist", "core", "package-manager.js"), "fixture");
      const launches: ChildProcess.Command[] = [];
      let nativeExitCode = 0;
      let nativeStderr = "";
      let hangNative = false;
      let nativeCleanups = 0;
      const nativeStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) => {
        launches.push(command);
        return Effect.gen(function* () {
          if (hangNative) {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                nativeCleanups += 1;
              }),
            );
            yield* Deferred.succeed(nativeStarted, undefined);
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(900_000_001),
            exitCode: hangNative
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(nativeExitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.succeed(
              new TextEncoder().encode('T3_PI_PACKAGES:{"packages":[],"scopeLabel":"fixture"}\n'),
            ),
            stderr: Stream.succeed(new TextEncoder().encode(nativeStderr)),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        });
      });
      let galleryHtml = catalog;
      let hangGallery = false;
      const requests: string[] = [];
      const galleryStarted = yield* Deferred.make<void>();
      const service = yield* PiPackages.PiPackages.pipe(
        Effect.provide(
          Layer.provide(
            PiPackages.layer,
            Layer.mergeAll(
              ServerConfig.layerTest(root, path.join(root, "t3")),
              ServerSettings.layerTest({
                providerInstances: {
                  [instanceId]: {
                    driver: "pi",
                    config: {},
                    environment: [
                      { name: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false },
                    ],
                  },
                },
              }),
              Layer.succeed(
                ProjectService.ProjectService,
                {} as ProjectService.ProjectService["Service"],
              ),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => {
                  requests.push(request.url);
                  return hangGallery
                    ? Deferred.succeed(galleryStarted, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.succeed(
                        HttpClientResponse.fromWeb(request, new Response(galleryHtml)),
                      );
                }),
              ),
              Layer.succeed(HostProcessPlatform, "linux"),
              Layer.succeed(SpawnExecutableResolution, () => binary),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        ),
      );
      expect((yield* service.list({ instanceId, scope: "global" })).packages).toEqual([]);
      expect(launches).toHaveLength(1);
      nativeExitCode = 1;
      nativeStderr = "https://user:private-token@git.example.invalid/repo";
      const failed = yield* service
        .mutate({
          instanceId,
          scope: "global",
          source: "npm:test-fixture",
          action: "update",
          consent: true,
        })
        .pipe(Effect.flip);
      expect(failed.message).toContain("diagnostics are withheld");
      expect(failed.message).not.toContain("private-token");
      nativeExitCode = 0;
      hangNative = true;
      const nativeFiber = yield* service
        .list({ instanceId, scope: "global" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(nativeStarted);
      yield* TestClock.adjust("21 seconds");
      expect((yield* Fiber.join(nativeFiber).pipe(Effect.flip)).message).toContain("timed out");
      expect(nativeCleanups).toBe(1);
      const found = yield* service.search({
        query: "fixture & package",
        type: "skill",
        sort: "recent",
        page: 2,
      });
      expect(found.packages).toHaveLength(1);
      expect(requests[0]).toBe(
        "https://pi.dev/packages?name=fixture+%26+package&type=skill&sort=recent&page=2",
      );
      const requestCount = requests.length;
      for (const page of [0, -1, 1.5, NaN, Infinity, 1000001])
        yield* service.search({ query: "", page }).pipe(Effect.flip);
      expect(requests).toHaveLength(requestCount);
      galleryHtml = "x".repeat(8 * 1024 * 1024 + 1);
      expect((yield* service.search({ query: "" }).pipe(Effect.flip)).message).toContain(
        "exceeded its limit",
      );
      hangGallery = true;
      const galleryFiber = yield* service.search({ query: "" }).pipe(Effect.forkChild);
      yield* Deferred.await(galleryStarted);
      yield* TestClock.adjust("16 seconds");
      expect((yield* Fiber.join(galleryFiber).pipe(Effect.flip)).message).toContain("timed out");
      const launch = launches[0];
      expect(launch && ChildProcess.isStandardCommand(launch)).toBe(true);
      if (launch && ChildProcess.isStandardCommand(launch)) {
        expect(JSON.parse(launch.args.at(-1) ?? "")).toMatchObject({
          agentDir,
          scope: "global",
          sdkRoot: root,
          cwd: root,
        });
      }
      yield* service.list({ instanceId, scope: "global", projectId }).pipe(Effect.flip);
      yield* service
        .mutate({ instanceId, scope: "global", source: "--all", action: "update", consent: true })
        .pipe(Effect.flip);
      expect(launches).toHaveLength(3);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
