import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const PI = ProviderDriverKind.make("pi");

function sessionContents(cwd: string, prompt = "Work on this project") {
  return (
    [
      {
        type: "session",
        version: 3,
        id: "00000000-0000-4000-8000-000000000001",
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
        cwd,
      },
      {
        type: "model_change",
        id: "model",
        parentId: null,
        provider: "openai",
        modelId: "Native-MODEL",
      },
      {
        type: "message",
        id: "user",
        parentId: "model",
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      },
      {
        type: "message",
        id: "assistant",
        parentId: "user",
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
        message: { role: "assistant", content: [{ type: "text", text: "Completed" }] },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n"
  );
}

const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-session-scanner-" });
  const workspace = path.join(root, "project");
  const home = path.join(root, "agent");
  const baseDir = path.join(root, "t3-data");
  yield* fileSystem.makeDirectory(workspace, { recursive: true });
  yield* TestClock.setTime(NOW);
  const write = Effect.fnUntraced(function* (filePath: string, contents: string, modifiedAt = NOW) {
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
    const modifiedDate = DateTime.toDateUtc(DateTime.makeUnsafe(modifiedAt));
    yield* fileSystem.utimes(filePath, modifiedDate, modifiedDate);
  });
  const sessionPath = (agentHome = home, name = "session.jsonl") =>
    path.join(agentHome, "sessions", "--project--", name);
  return { root, workspace, home, baseDir, write, sessionPath };
});

type Fixture = Effect.Success<typeof makeFixture>;

const withScanner = <Success, Error, Requirements>(
  fixture: Fixture,
  effect: Effect.Effect<Success, Error, Requirements | AgentSessionScanner.AgentSessionScanner>,
  options: {
    readonly instances?: ContractServerSettings["providerInstances"];
    readonly imported?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
) => {
  const project: OrchestrationProjectShell = {
    id: ProjectId.make("pi-project"),
    title: "Pi project",
    workspaceRoot: fixture.workspace,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
  };
  return effect.pipe(
    Effect.provide(
      AgentSessionScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              providerInstances: options.instances ?? {
                [ProviderInstanceId.make("pi")]: {
                  driver: PI,
                  enabled: true,
                  environment: [
                    { name: "PI_CODING_AGENT_DIR", value: fixture.home, sensitive: false },
                  ],
                },
              },
            }),
            ServerConfig.layerTest(fixture.workspace, fixture.baseDir),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed(options.imported ? [project] : []),
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(HostProcessEnvironment, options.environment ?? {}),
  );
};

const scan = AgentSessionScanner.AgentSessionScanner.use((scanner) => scanner.scan);
const recent = (workspace: string) =>
  AgentSessionScanner.AgentSessionScanner.use((scanner) =>
    scanner.recentThreads(workspace).pipe(Stream.runCollect),
  );

it.layer(NodeServices.layer)("native Pi sessions", (it) => {
  it.effect("discovers Pi projects and retains native path, model and active history", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const filePath = fixture.sessionPath();
      yield* fixture.write(filePath, sessionContents(fixture.workspace));
      const result = yield* withScanner(fixture, scan);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        path: fixture.workspace,
        sources: ["pi"],
        threadCount: 1,
        alreadyImported: false,
      });
      const outcomes = yield* withScanner(fixture, recent(fixture.workspace));
      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0]!;
      expect(outcome._tag).toBe("Importable");
      if (outcome._tag !== "Importable") return;
      expect(outcome.thread).toMatchObject({
        source: "pi",
        providerInstanceId: "pi",
        providerSessionId: filePath,
        model: "openai/Native-MODEL",
      });
      expect(outcome.source.filePath).toBe(filePath);
      expect(outcome.thread.messages.map((message) => message.text)).toEqual([
        "Work on this project",
        "Completed",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("marks an existing project without creating or changing it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* fixture.write(fixture.sessionPath(), sessionContents(fixture.workspace));
      const result = yield* withScanner(fixture, scan, { imported: true });
      expect(result.candidates[0]).toMatchObject({
        alreadyImported: true,
        projectId: "pi-project",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("ignores legacy harness transcripts, subagents and malformed Pi headers", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* fixture.write(fixture.sessionPath(), sessionContents(fixture.workspace));
      yield* fixture.write(
        fixture.sessionPath(fixture.home, "codex.jsonl"),
        JSON.stringify({
          type: "session_meta",
          payload: { id: "legacy", cwd: fixture.workspace },
        }) + "\n",
      );
      yield* fixture.write(
        fixture.sessionPath(fixture.home, "claude.jsonl"),
        JSON.stringify({ type: "user", sessionId: "legacy", cwd: fixture.workspace }) + "\n",
      );
      yield* fixture.write(
        fixture.sessionPath(fixture.home, "subagent-child.jsonl"),
        sessionContents(fixture.workspace),
      );
      yield* fixture.write(fixture.sessionPath(fixture.home, "broken.jsonl"), "not-json\n");
      const result = yield* withScanner(fixture, scan);
      expect(result.candidates[0]?.threadCount).toBe(1);
      expect(result.candidates[0]?.sources).toEqual(["pi"]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps separate Pi accounts and assigns shared homes to one owner", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const path = yield* Path.Path;
      const secondHome = path.join(fixture.root, "second-agent");
      yield* fixture.write(
        fixture.sessionPath(),
        sessionContents(fixture.workspace, "First account"),
      );
      yield* fixture.write(
        fixture.sessionPath(secondHome),
        sessionContents(fixture.workspace, "Second account"),
      );
      const instance = (home: string) => ({
        driver: PI,
        enabled: true,
        environment: [{ name: "PI_CODING_AGENT_DIR", value: home, sensitive: false }],
      });
      const instances = {
        pi: { driver: PI, enabled: false },
        first: instance(fixture.home),
        duplicate: instance(fixture.home),
        second: instance(secondHome),
      };
      const outcomes = yield* withScanner(fixture, recent(fixture.workspace), { instances });
      expect(outcomes).toHaveLength(2);
      expect(
        outcomes
          .flatMap((outcome) =>
            outcome._tag === "Importable" ? [outcome.thread.providerInstanceId] : [],
          )
          .sort(),
      ).toEqual(["first", "second"]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not scan disabled or invalid Pi configurations", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* fixture.write(fixture.sessionPath(), sessionContents(fixture.workspace));
      const result = yield* withScanner(fixture, scan, {
        instances: {
          [ProviderInstanceId.make("pi")]: { driver: PI, enabled: false },
          [ProviderInstanceId.make("disabled")]: {
            driver: PI,
            enabled: false,
            environment: [{ name: "PI_CODING_AGENT_DIR", value: fixture.home, sensitive: false }],
          },
          [ProviderInstanceId.make("invalid")]: {
            driver: PI,
            config: { binaryPath: 42 },
            environment: [{ name: "PI_CODING_AGENT_DIR", value: fixture.home, sensitive: false }],
          },
        },
      });
      expect(result.candidates).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("inherits Pi's agent directory from the server environment", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* fixture.write(fixture.sessionPath(), sessionContents(fixture.workspace));
      const result = yield* withScanner(fixture, scan, {
        instances: {},
        environment: { PI_CODING_AGENT_DIR: fixture.home },
      });
      expect(result.candidates).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("skips unchanged imports using file identity without rewriting native sessions", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const filePath = fixture.sessionPath();
      const contents = sessionContents(fixture.workspace);
      yield* fixture.write(filePath, contents);
      yield* withScanner(
        fixture,
        AgentSessionScanner.AgentSessionScanner.use((scanner) =>
          Effect.gen(function* () {
            const first = yield* scanner.recentThreads(fixture.workspace).pipe(Stream.runCollect);
            const source = first[0]?._tag === "Importable" ? first[0].source : null;
            expect(source).not.toBeNull();
            if (source === null) return;
            const repeated = yield* scanner
              .recentThreads(fixture.workspace, [source])
              .pipe(Stream.runCollect);
            expect(repeated).toEqual([{ _tag: "AlreadyImported", source }]);
          }),
        ),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      expect(yield* fileSystem.readFileString(filePath)).toBe(contents);
    }).pipe(Effect.scoped),
  );

  it.effect("skips missing projects, T3 data directories, old sessions and future sessions", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(fixture.baseDir, { recursive: true });
      yield* fixture.write(
        fixture.sessionPath(fixture.home, "missing.jsonl"),
        sessionContents(path.join(fixture.root, "missing")),
      );
      yield* fixture.write(
        fixture.sessionPath(fixture.home, "internal.jsonl"),
        sessionContents(fixture.baseDir),
      );
      yield* fixture.write(
        fixture.sessionPath(fixture.home, "old.jsonl"),
        sessionContents(fixture.workspace),
        NOW - 31 * 24 * 60 * 60 * 1000,
      );
      yield* fixture.write(
        fixture.sessionPath(fixture.home, "future.jsonl"),
        sessionContents(fixture.workspace),
        NOW + 60 * 60 * 1000,
      );
      expect(yield* withScanner(fixture, recent(fixture.workspace))).toEqual([]);
      const result = yield* withScanner(fixture, scan);
      expect(result.candidates.every((candidate) => candidate.path === fixture.workspace)).toBe(
        true,
      );
    }).pipe(Effect.scoped),
  );
});

it("imports only the active native branch and its session name", () => {
  const nativePath = "/pi-fixtures/native.jsonl";
  const records = sessionContents("/project")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  records.push(
    {
      type: "message",
      id: "branch-user",
      parentId: "user",
      message: { role: "user", content: "New branch" },
    },
    {
      type: "message",
      id: "branch-answer",
      parentId: "branch-user",
      message: { role: "assistant", content: [{ type: "text", text: "Current answer" }] },
    },
    { type: "session_info", id: "name", parentId: "branch-answer", name: "Native Pi title" },
  );
  const thread = AgentSessionScanner.parseAgentSessionTranscript({
    source: "pi",
    providerInstanceId: ProviderInstanceId.make("pi"),
    fallbackSessionId: nativePath,
    lastActiveAtMs: NOW,
    contents: records.map((record) => JSON.stringify(record)).join("\n"),
  });
  expect(thread?.title).toBe("Native Pi title");
  expect(thread?.messages.map((message) => message.text)).toEqual([
    "Work on this project",
    "New branch",
    "Current answer",
  ]);
});

it.each(["missing-parent", "duplicate-id", "malformed-json", "unsupported-version"])(
  "rejects unsafe native history: %s",
  (failure) => {
    let contents = sessionContents("/project");
    if (failure === "missing-parent")
      contents += JSON.stringify({
        type: "message",
        id: "orphan",
        parentId: "unknown",
        message: { role: "user", content: "Wrong branch" },
      });
    if (failure === "duplicate-id")
      contents += JSON.stringify({
        type: "message",
        id: "user",
        parentId: null,
        message: { role: "user", content: "Duplicate" },
      });
    if (failure === "malformed-json") contents += "{broken";
    if (failure === "unsupported-version")
      contents = contents.replace('"version":3', '"version":2');
    const path = "/pi-fixtures/native.jsonl";
    expect(
      AgentSessionScanner.parseAgentSessionTranscript({
        source: "pi",
        providerInstanceId: ProviderInstanceId.make("pi"),
        fallbackSessionId: path,
        lastActiveAtMs: NOW,
        contents,
      }),
    ).toBeNull();
  },
);

it("preserves the selected native model when virtual models answer through a physical model", () => {
  const records = sessionContents("/project")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const assistant = records.at(-1);
  assistant.message.provider = "anthropic";
  assistant.message.model = "physical-model";
  const thread = AgentSessionScanner.parseAgentSessionTranscript({
    source: "pi",
    providerInstanceId: ProviderInstanceId.make("pi"),
    fallbackSessionId: "/pi-fixtures/native.jsonl",
    lastActiveAtMs: NOW,
    contents: records.map((record) => JSON.stringify(record)).join("\n"),
  });
  expect(thread?.model).toBe("openai/Native-MODEL");
});

it.each([false, true])(
  "uses the latest model selection or response fallback: selected=%s",
  (selected) => {
    const records = sessionContents("/project")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const assistant = records.at(-1);
    assistant.message.provider = "openai";
    assistant.message.model = "old-physical-model";
    if (selected) {
      records.push({
        type: "model_change",
        id: "selected-model",
        parentId: "assistant",
        provider: "router",
        modelId: "selected-virtual-model",
      });
    } else {
      records.splice(1, 1);
      records[1].parentId = null;
    }
    records.push({
      type: "message",
      id: "latest-answer",
      parentId: selected ? "selected-model" : "assistant",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "latest-physical-model",
        content: "Current answer",
      },
    });
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      source: "pi",
      providerInstanceId: ProviderInstanceId.make("pi"),
      fallbackSessionId: "/pi-fixtures/native.jsonl",
      lastActiveAtMs: NOW,
      contents: records.map((record) => JSON.stringify(record)).join("\n"),
    });
    expect(thread?.model).toBe(
      selected ? "router/selected-virtual-model" : "anthropic/latest-physical-model",
    );
  },
);

it.each([
  { nativePath: "C:\\pi-fixtures\\native.jsonl", valid: true },
  { nativePath: "\\\\server\\share\\native.jsonl", valid: true },
  { nativePath: "C:native.jsonl", valid: false },
  { nativePath: "native.jsonl", valid: false },
])("validates native session path identity: $nativePath", ({ nativePath, valid }) => {
  const thread = AgentSessionScanner.parseAgentSessionTranscript({
    source: "pi",
    providerInstanceId: ProviderInstanceId.make("pi"),
    fallbackSessionId: nativePath,
    lastActiveAtMs: NOW,
    contents: sessionContents("C:\\project"),
  });
  if (valid) expect(thread?.providerSessionId).toBe(nativePath);
  else expect(thread).toBeNull();
});
