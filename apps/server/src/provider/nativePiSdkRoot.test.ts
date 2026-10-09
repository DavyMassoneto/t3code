import * as PlatformNodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveNativePiSdkRoot } from "./nativePiSdkRoot.ts";

const prefix = "C:\\Native Pi";
const sdkRoot = `${prefix}\\node_modules\\@earendil-works\\pi-coding-agent`;
const cli = "dist/bundle/cli.js";
const manifest = JSON.stringify({
  name: "@earendil-works/pi-coding-agent",
  version: "1.1.0",
  bin: { pi: cli },
});
const shim = `@"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\${cli.replaceAll("/", "\\")}" %*`;

const resolveFixture = (options: {
  readonly launcher: string;
  readonly shim?: string;
  readonly mixedRootCase?: boolean;
  readonly escapedModule?: boolean;
}) =>
  Effect.gen(function* () {
    const win32 = yield* Path.Path;
    const binary = win32.join(prefix, options.launcher);
    const missing = FileSystem.makeNoop({});
    const files = new Set(
      [
        binary,
        sdkRoot,
        win32.join(sdkRoot, cli),
        ...["auth-storage.js", "model-runtime.js"].map((module) =>
          win32.join(sdkRoot, "dist", "core", module),
        ),
      ].map((filename) => filename.toLowerCase()),
    );
    let rootReads = 0;
    const fs = FileSystem.makeNoop({
      realPath: (filename) => {
        if (!files.has(filename.toLowerCase())) return missing.realPath(filename);
        if (filename.toLowerCase() === sdkRoot.toLowerCase()) {
          rootReads += 1;
          return Effect.succeed(
            options.mixedRootCase && rootReads > 1 ? sdkRoot.toUpperCase() : sdkRoot,
          );
        }
        return Effect.succeed(
          options.escapedModule && filename.endsWith("model-runtime.js")
            ? win32.join(prefix, "other-sdk", "model-runtime.js")
            : filename,
        );
      },
      readFileString: (filename) => {
        if (filename.toLowerCase() === win32.join(sdkRoot, "package.json").toLowerCase())
          return Effect.succeed(manifest);
        if (filename.toLowerCase() === binary.toLowerCase())
          return Effect.succeed(options.shim ?? shim);
        return missing.readFileString(filename);
      },
    });
    return yield* resolveNativePiSdkRoot({
      binaryPath: "",
      environment: { PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(SpawnExecutableResolution, () => binary),
      Effect.provideService(HostProcessPlatform, "win32"),
    );
  }).pipe(Effect.provide(PlatformNodePath.layerWin32));

describe("native Pi SDK launcher binding", () => {
  it.effect.each(["pi.cmd", "pi.CMD", "PI.CmD", "pi.PS1"])(
    "accepts verified Windows npm launcher %s",
    (launcher) =>
      Effect.gen(function* () {
        expect(yield* resolveFixture({ launcher })).toBe(sdkRoot);
      }),
  );

  it.effect("compares Windows SDK path identity without case sensitivity", () =>
    Effect.gen(function* () {
      expect(yield* resolveFixture({ launcher: "pi.CMD", mixedRootCase: true })).toBe(sdkRoot);
    }),
  );

  it.effect("rejects unrelated launchers even with a native SDK sibling", () =>
    Effect.gen(function* () {
      expect(yield* resolveFixture({ launcher: "pi.exe" })).toBeUndefined();
      expect(
        yield* resolveFixture({ launcher: "pi.CMD", shim: '@"C:\\Other Pi\\cli.js" %*' }),
      ).toBeUndefined();
    }),
  );

  it.effect("rejects SDK modules that resolve outside the verified package", () =>
    Effect.gen(function* () {
      expect(yield* resolveFixture({ launcher: "pi.CMD", escapedModule: true })).toBeUndefined();
    }),
  );
});

describe("Windows native executable resolution", () => {
  it.effect("finds the authentic npm SDK using uppercase PATHEXT without a resolver stub", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-sdk-" });
      const root = path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent");
      yield* fs.makeDirectory(path.join(root, "dist", "bundle"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "dist", "core"), { recursive: true });
      yield* fs.writeFileString(path.join(directory, "pi.cmd"), shim);
      yield* fs.writeFileString(path.join(root, "package.json"), manifest);
      for (const module of [cli, "dist/core/auth-storage.js", "dist/core/model-runtime.js"])
        yield* fs.writeFileString(path.join(root, module), "");
      const environment = { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      const executable = yield* SpawnExecutableResolution;
      expect(executable("pi", "win32", environment)).toBe(path.join(directory, "pi.CMD"));
      expect(yield* resolveNativePiSdkRoot({ binaryPath: "", environment })).toBe(root);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
