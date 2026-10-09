import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { pathToFileURL } from "node:url";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { PI_CONNECTION_CREDENTIALS_NATIVE_SOURCE } from "./piConnectionCredentialsNative.ts";

const sdkRoot = process.env.PI_CREDENTIAL_TEST_SDK_ROOT;
const runNative = Effect.fnUntraced(
  function* (cwd: string, payload: unknown) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        ["--input-type=module", "-e", PI_CONNECTION_CREDENTIALS_NATIVE_SOURCE],
        {
          cwd,
          env: { ...process.env, HOME: cwd, USERPROFILE: cwd, PI_CODING_AGENT_DIR: cwd },
          forceKillAfter: "2 seconds",
        },
      ),
    );
    const [, stdout, stderr, code] = yield* Effect.all(
      [
        Stream.run(Stream.make(new TextEncoder().encode(JSON.stringify(payload))), child.stdin),
        collectUint8StreamText({ stream: child.stdout, maxBytes: 256 }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 256 }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout: stdout.text, stderr: stderr.text, code: Number(code) };
  },
  Effect.scoped,
  Effect.timeout("20 seconds"),
);

describe("native Pi credential helper", () => {
  it.effect(
    "rejects commands, unsafe IDs, missing consent and oversized input without diagnostics or storage",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-credential-denial-" });
        const authPath = path.join(root, "auth.json");
        const before = JSON.stringify({
          counterpart: { type: "api_key", key: "synthetic-counterpart" },
        });
        yield* fs.writeFileString(authPath, before);
        const input = {
          sdkRoot: root,
          agentDir: root,
          service: "fixture",
          apiKey: "synthetic-secret",
          consent: true,
        };
        for (const invalid of [
          { consent: false },
          { apiKey: "!synthetic-secret" },
          { apiKey: "  !synthetic-secret" },
          { apiKey: "synthetic-secret\n" },
          { apiKey: "x".repeat(8193) },
          { apiKey: "x".repeat(65537) },
          { service: "__proto__" },
          { service: "constructor" },
          { service: "prototype" },
          { service: "unknown" },
        ]) {
          const result = yield* runNative(root, { ...input, ...invalid });
          expect(result).toEqual({ code: 1, stdout: "", stderr: "" });
          expect(yield* fs.readFileString(authPath)).toBe(before);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(!sdkRoot)(
    "uses actual offline SDK locking, preserves counterpart profiles and literal dollar syntax",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-credential-sdk-" });
        const selected = path.join(root, "selected");
        const other = path.join(root, "other");
        yield* Effect.forEach([selected, other], (directory) => fs.makeDirectory(directory));
        const counterpart = {
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 0,
        };
        const initial = JSON.stringify({ selected: counterpart, untouched: counterpart });
        yield* Effect.forEach([selected, other], (directory) =>
          fs.writeFileString(path.join(directory, "auth.json"), initial),
        );
        const results = yield* Effect.all(
          [
            runNative(root, {
              sdkRoot,
              agentDir: selected,
              service: "selected",
              apiKey: "synthetic-$HOME",
              consent: true,
            }),
            runNative(root, {
              sdkRoot,
              agentDir: selected,
              service: "concurrent",
              apiKey: "synthetic-concurrent",
              consent: true,
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(results).toEqual([
          { code: 0, stdout: "T3_PI_CREDENTIALS_OK\n", stderr: "" },
          { code: 0, stdout: "T3_PI_CREDENTIALS_OK\n", stderr: "" },
        ]);
        expect(JSON.parse(yield* fs.readFileString(path.join(selected, "auth.json")))).toEqual({
          selected: { type: "api_key", key: "synthetic-$$HOME" },
          concurrent: { type: "api_key", key: "synthetic-concurrent" },
          untouched: counterpart,
        });
        expect(yield* fs.readFileString(path.join(other, "auth.json"))).toBe(initial);
        const resolved = yield* Effect.tryPromise(async () => {
          const sdk = await import(
            pathToFileURL(path.join(sdkRoot!, "dist", "core", "auth-storage.js")).href
          );
          return sdk.AuthStorage.create(path.join(selected, "auth.json")).read("selected");
        });
        expect(resolved).toEqual({ type: "api_key", key: "synthetic-$HOME" });
        yield* fs.writeFileString(path.join(selected, "auth.json"), "invalid-synthetic-json");
        expect(
          (yield* runNative(root, {
            sdkRoot,
            agentDir: selected,
            service: "selected",
            apiKey: "synthetic-secret",
            consent: true,
          })).code,
        ).toBe(1);
        expect(yield* fs.readFileString(path.join(selected, "auth.json"))).toBe(
          "invalid-synthetic-json",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
