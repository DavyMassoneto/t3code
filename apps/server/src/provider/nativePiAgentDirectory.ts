import type * as Path from "effect/Path";

export function resolveNativePiAgentDirectory(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly fallbackHome: string;
  readonly path: Pick<Path.Path, "join" | "normalize" | "isAbsolute">;
}): string {
  const readVariable = (name: string) => {
    if (input.platform !== "win32") return input.environment[name];
    const key = Object.keys(input.environment)
      .filter((candidate) => candidate.toUpperCase() === name)
      .sort()[0];
    return key === undefined ? undefined : input.environment[key];
  };
  const effectiveHome =
    readVariable(input.platform === "win32" ? "USERPROFILE" : "HOME") ?? input.fallbackHome;
  const configuredDirectory = readVariable("PI_CODING_AGENT_DIR");
  let directory = configuredDirectory || input.path.join(effectiveHome, ".pi", "agent");
  if (directory === "~") directory = effectiveHome;
  else if (
    directory.startsWith("~/") ||
    (input.platform === "win32" && directory.startsWith("~\\"))
  ) {
    directory = input.path.join(effectiveHome, directory.slice(2));
  }
  if (!input.path.isAbsolute(directory)) {
    throw new Error(
      "Relative PI_CODING_AGENT_DIR or instance home is ambiguous across projects. Configure an absolute path or a ~/ path with an absolute instance home before managing packages.",
    );
  }
  return input.path.normalize(directory);
}
