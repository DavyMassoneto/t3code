import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expandHomePathWith } from "../pathExpansion.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const NativePiManifest = Schema.Struct({
  name: Schema.Literal("@earendil-works/pi-coding-agent"),
  bin: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
});
const decodeNativePiManifest = Schema.decodeEffect(Schema.fromJsonString(NativePiManifest));
const decodeRuntimeProbe = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cli: Schema.String, node: Schema.String })),
);
const probeMarker = "T3_PI_SDK_RUNTIME:";

export const resolveNativePiSdkRoot = Effect.fnUntraced(
  function* (input: { readonly binaryPath: string; readonly environment: NodeJS.ProcessEnv }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executable = yield* SpawnExecutableResolution;
    const platform = yield* HostProcessPlatform;
    const binary = executable(
      expandHomePathWith(input.binaryPath || "pi", path),
      platform,
      input.environment,
    );
    if (!binary) return undefined;
    const realBinary = yield* fs.realPath(binary);
    const samePath = (left: string, right: string) =>
      platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    const findRoot = Effect.fnUntraced(function* (boundBinary: string, allowShim: boolean) {
      const binaryDirectory = path.dirname(boundBinary);
      let directory = binaryDirectory;
      for (let depth = 0; depth < 6; depth += 1) {
        for (const candidate of [
          directory,
          path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent"),
          path.join(directory, "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
        ]) {
          const verified = yield* Effect.gen(function* () {
            const root = yield* fs.realPath(candidate);
            const manifest = yield* fs.readFileString(path.join(root, "package.json"));
            if (manifest.length > 65536) return undefined;
            const pkg = yield* decodeNativePiManifest(manifest);
            const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi;
            if (!bin || path.isAbsolute(bin) || bin.split(/[\\/]/u).includes(".."))
              return undefined;
            const cli = yield* fs.realPath(path.join(root, bin));
            const within = (filename: string) => {
              const relative = path.relative(root, filename);
              return (
                !path.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`)
              );
            };
            if (!within(cli)) return undefined;
            for (const module of ["auth-storage.js", "model-runtime.js"]) {
              if (!within(yield* fs.realPath(path.join(root, "dist", "core", module))))
                return undefined;
            }
            if (!samePath(boundBinary, cli)) {
              if (!allowShim) return undefined;
              const shimRoot = path.join(
                binaryDirectory,
                "node_modules",
                "@earendil-works",
                "pi-coding-agent",
              );
              if (
                !samePath(root, yield* fs.realPath(shimRoot)) ||
                !["pi", "pi.cmd", "pi.ps1"].includes(
                  platform === "win32"
                    ? path.basename(boundBinary).toLowerCase()
                    : path.basename(boundBinary),
                )
              )
                return undefined;
              const shim = yield* fs.readFileString(boundBinary);
              if (shim.length > 65536) return undefined;
              const normalized = shim.replace(/\\/gu, "/");
              const suffix = `/node_modules/@earendil-works/pi-coding-agent/${bin.replace(/\\/gu, "/")}`;
              if (
                !["%dp0%", "%~dp0", "$basedir"].some((prefix) =>
                  normalized.includes(`"${prefix}${suffix}"`),
                )
              )
                return undefined;
            }
            return root;
          }).pipe(Effect.orElseSucceed(() => undefined));
          if (verified) return verified;
        }
        directory = path.dirname(directory);
      }
      return undefined;
    });
    const root = yield* findRoot(realBinary, true);
    if (root) return root;
    if (platform !== "win32" || path.extname(realBinary).toLowerCase() !== ".exe") return undefined;
    return yield* Effect.gen(function* () {
      const availableSpawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
      if (Option.isNone(availableSpawner)) return undefined;
      const spawner = availableSpawner.value;
      const probe = `process.stdout.write("${probeMarker}" + JSON.stringify({cli: process.argv[1], node: process.execPath}) + "\\n");`;
      const environment = Object.fromEntries(
        Object.entries(input.environment).filter(([key]) => key.toUpperCase() !== "NODE_OPTIONS"),
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(binary, ["--version"], {
          cwd: path.dirname(binary),
          env: {
            ...environment,
            NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(probe)}`,
          },
          extendEnv: false,
          forceKillAfter: "2 seconds",
        }),
      );
      const [stdout, , code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 8192 }),
          Stream.runDrain(child.stderr),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0 || stdout.truncated || stdout.invalidUtf8) return undefined;
      const records = stdout.text.split(/\r?\n/u).filter((line) => line.startsWith(probeMarker));
      const record = records[0];
      if (records.length !== 1 || !record) return undefined;
      const runtime = yield* decodeRuntimeProbe(record.slice(probeMarker.length));
      if (!path.isAbsolute(runtime.cli) || !path.isAbsolute(runtime.node)) return undefined;
      const runtimeCli = yield* fs.realPath(runtime.cli);
      yield* fs.realPath(runtime.node);
      return yield* findRoot(runtimeCli, false);
    }).pipe(Effect.timeout("5 seconds"), Effect.scoped);
  },
  Effect.orElseSucceed(() => undefined),
);
