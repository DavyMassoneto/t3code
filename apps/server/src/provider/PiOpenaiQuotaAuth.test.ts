import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makePiOpenaiQuotaAuth } from "./PiOpenaiQuotaAuth.ts";
import { PI_OPENAI_QUOTA_AUTH_NATIVE_SOURCE } from "./piOpenaiQuotaAuthNative.ts";

const instanceId = ProviderInstanceId.make("pi-quota-fixture");
const runtimeSdkRoot = process.env.PI_QUOTA_TEST_SDK_ROOT;
for (const pollResult of ["pending", "error"] as const) {
  it.effect.skipIf(!runtimeSdkRoot)(
    `installed native SDK emits a device callback after stdin EOF and handles ${pollResult} without credentials`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const agentDir = yield* fs.makeTempDirectoryScoped();
        const authPath = path.join(agentDir, "auth.json");
        let changed = 0;
        let stopped = 0;
        const syntheticFetch = String.raw`
globalThis.fetch = async (url, options) => {
  if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
    return Response.json({device_auth_id: "synthetic-device", user_code: "ABCD-EFGH", interval: 0});
  }
  if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
    if (${JSON.stringify(pollResult)} === "error") throw new Error("NEVER_EXPORT_NATIVE_QUOTA_TOKEN");
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), {once: true});
    });
  }
  throw new Error("Unexpected synthetic request");
};
`;
        const spawner = ChildProcessSpawner.make((command) => {
          assert.equal(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
          return realSpawner.spawn(
            ChildProcess.make(
              command.command,
              ["--input-type=module", "-e", syntheticFetch + PI_OPENAI_QUOTA_AUTH_NATIVE_SOURCE],
              command.options,
            ),
          );
        });
        const controller = yield* makePiOpenaiQuotaAuth({
          instanceId,
          agentDir,
          sdkRoot: runtimeSdkRoot!,
          cwd: agentDir,
          environment: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            NODE_OPTIONS: "",
          },
          onChanged: Effect.sync(() => {
            changed += 1;
          }),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const started = yield* controller.start(
          "owner",
          Effect.sync(() => {
            stopped += 1;
          }),
          "pi-openai-quota-device",
        );
        assert.equal(started.phase, "starting");
        const state = yield* controller.subscribe("owner").pipe(
          Stream.filter(
            (state) => state.phase === (pollResult === "pending" ? "waiting" : "failed"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        if (pollResult === "pending") {
          assert.deepEqual(state.interaction, {
            type: "deviceCode",
            id: started.flowId!,
            url: "https://auth.openai.com/codex/device",
            userCode: "ABCD-EFGH",
          });
          assert.isTrue(yield* controller.isChangingCredentials!);
          yield* controller.cancel("owner", started.flowId!);
        } else {
          assert.notInclude(state.message ?? "", "NEVER_EXPORT_NATIVE_QUOTA_TOKEN");
        }
        assert.isFalse(yield* controller.isChangingCredentials!);
        assert.deepEqual(JSON.parse(yield* fs.readFileString(authPath)), {});
        assert.equal(changed, 0);
        assert.equal(stopped, 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    15000,
  );
}

const makeHarness = Effect.gen(function* () {
  const approved = yield* Deferred.make<void>();
  const payloads: Array<{ action: string; agentDir: string }> = [];
  let stopCalls = 0;
  let changed = 0;
  let killed = 0;
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          killed += 1;
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999999999),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        exitCode: Deferred.await(exited),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            const input = JSON.parse(new TextDecoder().decode(chunk)) as {
              action: string;
              agentDir: string;
            };
            payloads.push(input);
            if (input.action === "login") {
              yield* Queue.offer(
                stdout,
                encoder.encode(
                  JSON.stringify({
                    type: "device_code",
                    url: "https://auth.openai.com/codex/device",
                    userCode: "ABCD-EFGH",
                  }) + "\n",
                ),
              );
              yield* Deferred.await(approved);
            }
            yield* Queue.offer(
              stdout,
              encoder.encode(
                JSON.stringify({ type: "complete", configured: input.action === "login" }) + "\n",
              ),
            );
            yield* Queue.end(stdout);
            yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
          }),
        ),
      });
    }),
  );
  const build = makePiOpenaiQuotaAuth({
    instanceId,
    agentDir: "/synthetic/profile",
    sdkRoot: "/synthetic/sdk",
    cwd: "/synthetic/workspace",
    environment: {},
    onChanged: Effect.sync(() => {
      changed += 1;
    }),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  return {
    build,
    approved,
    payloads,
    stop: Effect.sync(() => {
      stopCalls += 1;
    }),
    counters: () => ({ stopCalls, changed, killed }),
  };
});

it.effect("quota sign-in never stops or gates direct Pi inference", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const controller = yield* harness.build;
    assert.isFalse(controller.affectsInference);
    yield* controller.start("owner", harness.stop, "pi-openai-quota-device");
    const waiting = yield* controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === "waiting"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.equal(waiting.interaction?.type, "deviceCode");
    assert.isTrue(yield* controller.isChangingCredentials!);
    assert.equal(harness.counters().stopCalls, 0);
    yield* Deferred.succeed(harness.approved, undefined);
    yield* controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === "succeeded"),
      Stream.runHead,
    );
    assert.equal(harness.counters().changed, 1);
    assert.equal(harness.payloads[0]?.agentDir, "/synthetic/profile");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("quota sign-out ignores generic session teardown", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const controller = yield* harness.build;
    yield* controller.logout(harness.stop);
    assert.equal(harness.counters().stopCalls, 0);
    assert.equal(harness.payloads[0]?.action, "logout");
    assert.equal(harness.counters().changed, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "closing the selected instance scope cancels its pending native login before completion",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const selectedScope = yield* Scope.make();
      const controller = yield* harness.build.pipe(
        Effect.provideService(Scope.Scope, selectedScope),
      );
      yield* controller.start("owner", harness.stop, "pi-openai-quota-device");
      yield* controller.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === "waiting"),
        Stream.runHead,
      );
      yield* Scope.close(selectedScope, Exit.void);
      assert.equal(harness.counters().killed, 1);
      assert.equal(harness.counters().changed, 0);
      assert.equal(harness.counters().stopCalls, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
