import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const nativePiFile = "/pi-fixtures/session.jsonl";
const cases = [
  {
    name: "legacy Codex",
    provider: "codex" as const,
    sessionId: "native-codex-thread",
    filePath: "/tmp/native-codex-thread.jsonl",
    valid: true,
  },
  {
    name: "native Pi",
    provider: "pi" as const,
    sessionId: nativePiFile,
    filePath: nativePiFile,
    valid: true,
  },
  {
    name: "relative Pi identity",
    provider: "pi" as const,
    sessionId: "session.jsonl",
    filePath: "session.jsonl",
    valid: false,
  },
  {
    name: "native Pi Windows drive path",
    provider: "pi" as const,
    sessionId: "C:\\pi-fixtures\\session.jsonl",
    filePath: "C:\\pi-fixtures\\session.jsonl",
    valid: true,
  },
  {
    name: "native Pi Windows UNC path",
    provider: "pi" as const,
    sessionId: "\\\\server\\share\\session.jsonl",
    filePath: "\\\\server\\share\\session.jsonl",
    valid: true,
  },
  {
    name: "drive-relative Pi identity",
    provider: "pi" as const,
    sessionId: "C:session.jsonl",
    filePath: "C:session.jsonl",
    valid: false,
  },
  {
    name: "mismatched Pi file",
    provider: "pi" as const,
    sessionId: nativePiFile,
    filePath: "/pi-fixtures/other.jsonl",
    valid: false,
  },
  {
    name: "Pi header UUID instead of file identity",
    provider: "pi" as const,
    sessionId: "00000000-0000-4000-8000-000000000001",
    filePath: nativePiFile,
    valid: false,
  },
  {
    name: "Pi non-JSONL file",
    provider: "pi" as const,
    sessionId: "/pi-fixtures/session.txt",
    filePath: "/pi-fixtures/session.txt",
    valid: false,
  },
];

it.effect.each(cases)(
  "$name: imports resumable sessions once and rejects unsafe identities",
  (fixture) => {
    const providerInstanceId = ProviderInstanceId.make(fixture.provider);
    const providerSessionId = fixture.sessionId;
    const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    const upserts: Array<unknown> = [];
    const recorded: Array<unknown> = [];
    let imported = false;
    const scanner = AgentSessionScanner.AgentSessionScanner.of({
      scan: Effect.die("unused"),
      recentThreads: () =>
        Stream.succeed({
          _tag: "Importable",
          source: {
            provider: fixture.provider,
            providerInstanceId,
            providerSessionId,
            filePath: fixture.filePath,
            size: 100,
            mtimeMs: 2,
            device: 3,
            inode: 4,
            birthtimeMs: 1,
          },
          thread: {
            source: fixture.provider,
            providerInstanceId,
            providerSessionId,
            title: "Imported thread",
            model: "gpt-5.4",
            createdAt: "2026-09-01T10:00:00.000Z",
            updatedAt: "2026-09-01T10:01:00.000Z",
            messages: [
              { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
              { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
            ],
          },
        }),
    });
    const layerTest = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              imported
                ? Effect.succeed({
                    thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                  } as never)
                : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                writes.push(input.events);
                imported = true;
                return [];
              }),
          }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            list: () => Effect.succeed([]),
            upsert: (input) => Effect.sync(() => void upserts.push(input)),
            recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
          }),
          IdAllocator.layer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: fixture.valid ? 1 : 0,
        skippedCount: fixture.valid ? 0 : 1,
      });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: fixture.valid ? 1 : 0,
        skippedCount: fixture.valid ? 0 : 1,
      });

      if (!fixture.valid) {
        expect(writes).toEqual([]);
        expect(upserts).toEqual([]);
        expect(recorded).toEqual([]);
        return;
      }

      expect(writes).toHaveLength(1);
      expect(writes[0]?.map((event) => event.type)).toEqual([
        "thread.created",
        "message.updated",
        "turn-item.updated",
        "message.updated",
        "turn-item.updated",
        "provider-thread.updated",
      ]);
      const created = writes[0]?.find((event) => event.type === "thread.created");
      const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
      expect(created?.payload).toMatchObject({
        id: threadId,
        activeProviderThreadId: providerThread?.payload.id,
        historyOrigin: "v1_import",
      });
      expect(providerThread?.payload).toMatchObject({
        appThreadId: threadId,
        nativeThreadRef: {
          driver: fixture.provider,
          nativeId: providerSessionId,
          strength: "strong",
        },
      });
      expect(
        writes[0]
          ?.filter((event) => event.type === "message.updated")
          .map((event) => event.payload.text),
      ).toEqual(["Fix it", "Fixed"]);
      expect(upserts).toEqual([
        expect.objectContaining({
          threadId,
          providerInstanceId,
          resumeCursor:
            fixture.provider === "pi"
              ? { sessionFile: providerSessionId }
              : { threadId: providerSessionId },
        }),
      ]);
      expect(recorded).toHaveLength(2);
    }).pipe(Effect.provide(layerTest));
  },
);
