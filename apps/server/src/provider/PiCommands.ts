import {
  PI_RUNTIME_POLICY_COMMAND_PREFIX,
  PI_RUNTIME_POLICY_METADATA_PREFIX,
  type ProviderRuntimePolicy,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

// Pi RPC get_commands omits TUI builtins. Advertise /compact so T3 can map it to RPC compact.
export const PI_COMPACT_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage",
  input: { hint: "Optional instructions" },
};

export const PI_BUILTIN_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  PI_COMPACT_SLASH_COMMAND,
  {
    name: "pi-auto-compaction",
    description: "Enable or disable Pi's automatic context compaction",
    input: { hint: "on | off" },
  },
  {
    name: "pi-auto-retry",
    description: "Enable or disable Pi's automatic retry of transient failures",
    input: { hint: "on | off" },
  },
  {
    name: "pi-steering-mode",
    description: "Choose how Pi delivers queued steering messages",
    input: { hint: "all | one-at-a-time" },
  },
  {
    name: "pi-follow-up-mode",
    description: "Choose how Pi delivers queued follow-up messages",
    input: { hint: "all | one-at-a-time" },
  },
];

interface PiControlCommand {
  readonly label: string;
  readonly request:
    | { readonly type: "set_auto_compaction" | "set_auto_retry"; readonly enabled: boolean }
    | {
        readonly type: "set_steering_mode" | "set_follow_up_mode";
        readonly mode: "all" | "one-at-a-time";
      };
}

export function parsePiControlCommand(
  text: string,
):
  | { readonly ok: true; readonly command: PiControlCommand }
  | { readonly ok: false; readonly message: string }
  | null {
  const parts = text.trim().split(/\s+/);
  const name = parts[0];
  const value = parts[1];
  if (name === "/pi-auto-compaction" || name === "/pi-auto-retry") {
    if (parts.length !== 2 || (value !== "on" && value !== "off")) {
      return { ok: false, message: `Usage: ${name} on|off` };
    }
    return {
      ok: true,
      command: {
        label: `${name === "/pi-auto-compaction" ? "Automatic compaction" : "Automatic retry"}: ${value}`,
        request: {
          type: name === "/pi-auto-compaction" ? "set_auto_compaction" : "set_auto_retry",
          enabled: value === "on",
        },
      },
    };
  }
  if (name === "/pi-steering-mode" || name === "/pi-follow-up-mode") {
    if (parts.length !== 2 || (value !== "all" && value !== "one-at-a-time")) {
      return { ok: false, message: `Usage: ${name} all|one-at-a-time` };
    }
    return {
      ok: true,
      command: {
        label: `${name === "/pi-steering-mode" ? "Steering mode" : "Follow-up mode"}: ${value}`,
        request: {
          type: name === "/pi-steering-mode" ? "set_steering_mode" : "set_follow_up_mode",
          mode: value,
        },
      },
    };
  }
  return null;
}

export interface PiCompactCommand {
  readonly customInstructions?: string;
}

export function parsePiCompactCommand(text: string): PiCompactCommand | null {
  const trimmed = text.trim();
  if (trimmed === "/compact") return {};
  if (!trimmed.startsWith("/compact")) return null;
  const rest = trimmed.slice("/compact".length);
  if (rest.length === 0) return {};
  if (!/^\s/.test(rest)) return null;
  const customInstructions = rest.trim();
  return customInstructions.length === 0 ? {} : { customInstructions };
}

export function withPiBuiltinSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const builtinNames = new Set(PI_BUILTIN_SLASH_COMMANDS.map((command) => command.name));
  return [
    ...PI_BUILTIN_SLASH_COMMANDS,
    ...commands.filter((command) => !builtinNames.has(command.name)),
  ];
}

export interface PiDiscoveredCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export function parsePiRuntimePolicies(data: unknown): ReadonlyArray<ProviderRuntimePolicy> {
  const commands = recordField(data, "commands");
  if (!Array.isArray(commands)) return [];
  const policies: ProviderRuntimePolicy[] = [];
  const counts = new Map<string, number>();
  for (const command of commands) {
    const name = exactString(command, "name");
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const command of commands) {
    const name = exactString(command, "name");
    const metadata = exactString(command, "description");
    if (
      exactString(command, "source") !== "extension" ||
      name === undefined ||
      counts.get(name) !== 1 ||
      !name.startsWith(PI_RUNTIME_POLICY_COMMAND_PREFIX) ||
      metadata === undefined ||
      metadata.length > 4_096 ||
      !metadata.startsWith(PI_RUNTIME_POLICY_METADATA_PREFIX)
    )
      continue;
    const id = name.slice(PI_RUNTIME_POLICY_COMMAND_PREFIX.length);
    if (id.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) continue;
    let descriptor: unknown;
    try {
      descriptor = JSON.parse(metadata.slice(PI_RUNTIME_POLICY_METADATA_PREFIX.length));
    } catch {
      continue;
    }
    const label = exactString(descriptor, "label");
    const extensionName = exactString(descriptor, "extensionName");
    const description = exactString(descriptor, "description");
    if (
      exactString(descriptor, "id") !== id ||
      label === undefined ||
      label.trim() !== label ||
      label.length === 0 ||
      label.length > 200 ||
      extensionName === undefined ||
      extensionName.trim() !== extensionName ||
      extensionName.length === 0 ||
      extensionName.length > 200 ||
      (recordField(descriptor, "description") !== undefined &&
        (description === undefined ||
          description.trim() !== description ||
          description.length === 0 ||
          description.length > 2_000))
    )
      continue;
    policies.push({
      id,
      label,
      extensionName,
      command: name,
      ...(description === undefined ? {} : { description }),
    });
  }
  return policies;
}

export function isPiRuntimePolicyCommand(text: string): boolean {
  return /^\/(?:pi-desktop-policy-|t3-pi-runtime-policy-state(?:\s|$))/.test(text.trimStart());
}

function normalizePiSkillScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const normalized = scope.trim().toLowerCase();
  if (normalized === "global" || normalized === "personal") return "user";
  if (normalized === "workspace" || normalized === "local") return "project";
  return scope;
}

/** Maps Pi's `get_commands` payload to T3's shared command and skill surfaces. */
export function parsePiDiscoveredCommands(data: unknown): PiDiscoveredCommands {
  const commands = recordField(data, "commands");
  if (!Array.isArray(commands)) return { slashCommands: [], skills: [] };
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    const commandName = recordString(command, "name");
    if (commandName === undefined || commandName.length === 0) continue;
    if (isPiRuntimePolicyCommand(`/${commandName}`)) continue;
    const description = recordString(command, "description");
    if (recordString(command, "source") === "skill") {
      const name = commandName.startsWith("skill:")
        ? commandName.slice("skill:".length)
        : commandName;
      if (name.length === 0) continue;
      const sourceInfo = recordField(command, "sourceInfo");
      const commandInterface = recordField(command, "interface");
      const path =
        recordString(sourceInfo, "path") ?? recordString(command, "path") ?? `pi:skill:${name}`;
      const scope = normalizePiSkillScope(
        recordString(sourceInfo, "scope") ?? recordString(command, "location"),
      );
      const displayName =
        recordString(command, "displayName") ??
        recordString(sourceInfo, "displayName") ??
        recordString(commandInterface, "displayName");
      const shortDescription =
        recordString(command, "shortDescription") ??
        recordString(sourceInfo, "shortDescription") ??
        recordString(commandInterface, "shortDescription");
      skills.push({
        name,
        path,
        enabled: true,
        ...(description === undefined ? {} : { description }),
        ...(scope === undefined ? {} : { scope }),
        ...(displayName === undefined ? {} : { displayName }),
        ...(shortDescription === undefined ? {} : { shortDescription }),
      });
      continue;
    }
    slashCommands.push({
      name: commandName,
      ...(description === undefined ? {} : { description }),
    });
  }
  return { slashCommands, skills };
}

/**
 * Pi expands skills only through leading `/skill:name` commands. T3 stores
 * skill chips as `$name`, so hoist every known `$skill` to that native
 * command position while preserving the rest of the user's prompt.
 */
export function expandPiSkillReference(text: string, skillNames: ReadonlySet<string>): string {
  const references = /(^|\s)\$([^\s]+)(?=\s|$)/g;
  const found: Array<{ name: string; start: number; end: number }> = [];
  for (const match of text.matchAll(references)) {
    const name = match[2];
    if (name === undefined || !skillNames.has(name) || match.index === undefined) continue;
    const tokenStart = match.index + (match[1]?.length ?? 0);
    found.push({ name, start: tokenStart, end: tokenStart + name.length + 1 });
  }
  if (found.length === 0) return text;

  const orderedNames: string[] = [];
  const seen = new Set<string>();
  for (const token of found) {
    if (seen.has(token.name)) continue;
    seen.add(token.name);
    orderedNames.push(token.name);
  }

  let body = text;
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const token = found[index];
    if (token === undefined) continue;
    body = `${body.slice(0, token.start)}${body.slice(token.end)}`;
  }
  body = body.trim();
  const prefix = orderedNames.map((name) => `/skill:${name}`).join(" ");
  return body.length === 0 ? prefix : `${prefix} ${body}`;
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

function recordString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function exactString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" ? value : undefined;
}
