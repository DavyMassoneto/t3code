import * as PlatformNodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
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
const probeSpawner = (output: string, code = 0) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: code === -1 ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(new TextEncoder().encode(output)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

const resolveFixture = (options: {
  readonly launcher: string;
  readonly shim?: string;
  readonly mixedRootCase?: boolean;
  readonly escapedModule?: boolean;
  readonly platform?: "win32" | "linux";
  readonly symlink?: boolean;
}) =>
  Effect.gen(function* () {
    const win32 = yield* Path.Path;
    const fixturePrefix = options.platform === "linux" ? "/native-pi" : prefix;
    const sdkRoot = win32.join(fixturePrefix, "node_modules", "@earendil-works", "pi-coding-agent");
    const binary = win32.join(fixturePrefix, options.launcher);
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
        if (options.symlink && filename === binary) return Effect.succeed(win32.join(sdkRoot, cli));
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
      Effect.provideService(HostProcessPlatform, options.platform ?? "win32"),
    );
  }).pipe(
    Effect.provide(
      options.platform === "linux" ? PlatformNodePath.layerPosix : PlatformNodePath.layerWin32,
    ),
  );

describe("native Pi SDK launcher binding", () => {
  it.effect.each([
    { launcher: "pi", symlink: true },
    { launcher: "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" },
    {
      launcher: "pi",
      shim: '"$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"',
    },
  ])("accepts Unix CLI, symlink and npm shell launcher: %j", (options) =>
    Effect.gen(function* () {
      expect(yield* resolveFixture({ ...options, platform: "linux" })).toBe(
        "/native-pi/node_modules/@earendil-works/pi-coding-agent",
      );
    }),
  );
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

describe("native Windows runtime SDK binding", () => {
  const resolveShim = (
    options: {
      readonly output?: string;
      readonly exitCode?: number;
      readonly entrypoint?: string;
      readonly escapedModule?: boolean;
      readonly escapedCli?: boolean;
      readonly wrongManifest?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nvm = "C:\\Author Software\\nvm";
      const binary = path.join(nvm, ".nodejs", "pi.EXE");
      const realBinary = path.join(nvm, ".shim", "pi.exe");
      const install = path.join(nvm, "installs", "v24.21.0");
      const root = path.join(install, "node_modules", "@earendil-works", "pi-coding-agent");
      const runtimeCli = path.join(root, cli);
      const node = path.join(install, "node.exe");
      const files = new Set(
        [
          binary,
          realBinary,
          root,
          runtimeCli,
          node,
          path.join(install, "other-cli.js"),
          ...["auth-storage.js", "model-runtime.js"].map((module) =>
            path.join(root, "dist", "core", module),
          ),
        ].map((filename) => filename.toLowerCase()),
      );
      const missing = FileSystem.makeNoop({});
      const fs = FileSystem.makeNoop({
        realPath: (filename) => {
          if (!files.has(filename.toLowerCase())) return missing.realPath(filename);
          if (filename.toLowerCase() === binary.toLowerCase()) return Effect.succeed(realBinary);
          if (
            (options.escapedModule && filename.endsWith("model-runtime.js")) ||
            (options.escapedCli && filename.toLowerCase() === runtimeCli.toLowerCase())
          )
            return Effect.succeed(path.join(install, "other-cli.js"));
          return Effect.succeed(filename);
        },
        readFileString: (filename) =>
          filename.toLowerCase() === path.join(root, "package.json").toLowerCase()
            ? Effect.succeed(
                options.wrongManifest
                  ? manifest.replace("pi-coding-agent", "other-agent")
                  : manifest,
              )
            : missing.readFileString(filename),
      });
      const launches: ChildProcess.Command[] = [];
      const output =
        options.output ??
        `T3_PI_SDK_RUNTIME:${JSON.stringify({ cli: options.entrypoint ?? runtimeCli, node })}\n1.1.0\n`;
      const delegate = probeSpawner(output, options.exitCode);
      const spawner = ChildProcessSpawner.make((command) => {
        launches.push(command);
        return delegate.spawn(command);
      });
      const environment = {
        PATH: path.join(nvm, ".nodejs"),
        node_options: "--require unrelated.cjs",
        PI_CODING_AGENT_DIR: "C:\\instance-agent",
      };
      const resolved = yield* resolveNativePiSdkRoot({ binaryPath: binary, environment }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(SpawnExecutableResolution, () => binary),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      expect(launches).toHaveLength(1);
      const command = launches[0];
      expect(command && ChildProcess.isStandardCommand(command)).toBe(true);
      if (command && ChildProcess.isStandardCommand(command)) {
        expect(command.command).toBe(binary);
        expect(command.args).toEqual(["--version"]);
        expect(command.options.env).toMatchObject({
          PATH: environment.PATH,
          PI_CODING_AGENT_DIR: environment.PI_CODING_AGENT_DIR,
        });
        expect(command.options.env).not.toHaveProperty("node_options");
        expect(command.options.env?.NODE_OPTIONS).toContain("--import=data:text/javascript,");
        expect(command.options.extendEnv).toBe(false);
      }
      expect(environment.node_options).toBe("--require unrelated.cjs");
      return { resolved, root };
    }).pipe(Effect.provide(PlatformNodePath.layerWin32));

  it.effect("binds .nodejs -> .shim EXE to the observed CLI in the active install", () =>
    Effect.gen(function* () {
      const { resolved, root } = yield* resolveShim();
      expect(resolved).toBe(root);
    }),
  );
  it.effect("bounds a hung native probe to five seconds", () =>
    Effect.gen(function* () {
      const fiber = yield* resolveShim({ exitCode: -1 }).pipe(Effect.forkChild);
      yield* TestClock.adjust("6 seconds");
      expect((yield* Fiber.join(fiber)).resolved).toBeUndefined();
    }),
  );

  it.effect.each([
    { output: "1.1.0\n" },
    { output: "T3_PI_SDK_RUNTIME:not-json\n" },
    { output: "x".repeat(8193) },
    { exitCode: 1 },
    { entrypoint: "C:\\Author Software\\nvm\\installs\\v24.21.0\\other-cli.js" },
    { entrypoint: "relative-cli.js" },
    { escapedModule: true },
    { escapedCli: true },
    { wrongManifest: true },
  ])("rejects unbound or invalid runtime evidence: %j", (options) =>
    Effect.gen(function* () {
      expect((yield* resolveShim(options)).resolved).toBeUndefined();
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
