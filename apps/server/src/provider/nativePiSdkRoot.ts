import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expandHomePathWith } from "../pathExpansion.ts";

const NativePiManifest = Schema.Struct({
  name: Schema.Literal("@earendil-works/pi-coding-agent"),
  bin: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
});
const decodeNativePiManifest = Schema.decodeEffect(Schema.fromJsonString(NativePiManifest));

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
    const binaryDirectory = path.dirname(realBinary);
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
          if (!bin || path.isAbsolute(bin) || bin.split(/[\\/]/u).includes("..")) return undefined;
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
          if (!samePath(realBinary, cli)) {
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
                  ? path.basename(realBinary).toLowerCase()
                  : path.basename(realBinary),
              )
            )
              return undefined;
            const shim = yield* fs.readFileString(realBinary);
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
  },
  Effect.orElseSucceed(() => undefined),
);
