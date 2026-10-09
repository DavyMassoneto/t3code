import { expect, it } from "@effect/vitest";

import {
  expandPiSkillReference,
  parsePiCompactCommand,
  parsePiDiscoveredCommands,
  parsePiRuntimePolicies,
  PI_BUILTIN_SLASH_COMMANDS,
  parsePiControlCommand,
  withPiBuiltinSlashCommands,
} from "./PiCommands.ts";

const declaredPolicy = {
  name: "pi-desktop-policy-example-auto",
  source: "extension",
  description:
    'pi-desktop-policy/v1:{"id":"example-auto","label":"Example Auto","extensionName":"example"}',
};

it("discovers only explicit extension policy declarations in native order", () => {
  expect(
    parsePiRuntimePolicies({
      commands: [
        { name: "auto", source: "extension" },
        declaredPolicy,
        {
          ...declaredPolicy,
          name: "pi-desktop-policy-second",
          description:
            'pi-desktop-policy/v1:{"id":"second","label":"Second","extensionName":"other"}',
        },
      ],
    }),
  ).toEqual([
    {
      id: "example-auto",
      label: "Example Auto",
      extensionName: "example",
      command: declaredPolicy.name,
    },
    { id: "second", label: "Second", extensionName: "other", command: "pi-desktop-policy-second" },
  ]);
});

it.each([
  { ...declaredPolicy, source: "prompt" },
  { ...declaredPolicy, source: "skill" },
  { ...declaredPolicy, source: undefined },
  { ...declaredPolicy, source: " extension " },
  { ...declaredPolicy, name: " pi-desktop-policy-example-auto " },
  {
    ...declaredPolicy,
    description:
      'pi-desktop-policy/v1:{"id":" example-auto ","label":"Example","extensionName":"example"}',
  },
  {
    ...declaredPolicy,
    description:
      'pi-desktop-policy/v1:{"id":"example-auto","label":" Example ","extensionName":"example"}',
  },
  { ...declaredPolicy, name: "auto" },
  { ...declaredPolicy, name: "pi-desktop-policy-other" },
  { ...declaredPolicy, name: `pi-desktop-policy-${"a".repeat(65)}` },
  { ...declaredPolicy, description: "pi-desktop-policy/v1:not JSON" },
  {
    ...declaredPolicy,
    description: 'pi-desktop-policy/v1:{"id":"example-auto","label":"Example"}',
  },
  {
    ...declaredPolicy,
    description:
      'pi-desktop-policy/v1:{"id":"example-auto","label":"Example","extensionName":"example","description":5}',
  },
])("rejects spoofed, implicit or malformed policy metadata: %j", (command) => {
  expect(parsePiRuntimePolicies({ commands: [command] })).toEqual([]);
});

it("does not choose duplicate or conflicting native command registrations", () => {
  expect(parsePiRuntimePolicies({ commands: [declaredPolicy, declaredPolicy] })).toEqual([]);
  expect(
    parsePiRuntimePolicies({ commands: [declaredPolicy, { ...declaredPolicy, source: "prompt" }] }),
  ).toEqual([]);
});

it("hides reserved policy protocol commands from the slash catalog", () => {
  expect(
    parsePiDiscoveredCommands({
      commands: [
        declaredPolicy,
        { name: "t3-pi-runtime-policy-state", source: "extension" },
        { name: "auto", source: "extension" },
      ],
    }).slashCommands,
  ).toEqual([{ name: "auto" }]);
});

it("maps current Pi skill metadata to T3's user and project skill scopes", () => {
  expect(
    parsePiDiscoveredCommands({
      commands: [
        {
          name: "skill:global-review",
          description: "Review changes.",
          source: "skill",
          sourceInfo: {
            path: "/home/test/.agents/skills/global-review/SKILL.md",
            scope: "user",
          },
        },
        {
          name: "skill:project-deploy",
          description: "Deploy this project.",
          source: "skill",
          sourceInfo: {
            path: "/workspace/.agents/skills/project-deploy/SKILL.md",
            scope: "project",
          },
        },
        { name: "hello", description: "Say hello.", source: "extension" },
      ],
    }),
  ).toEqual({
    skills: [
      {
        name: "global-review",
        description: "Review changes.",
        path: "/home/test/.agents/skills/global-review/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "project-deploy",
        description: "Deploy this project.",
        path: "/workspace/.agents/skills/project-deploy/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ],
    slashCommands: [{ name: "hello", description: "Say hello." }],
  });
});

it("maps Pi global location and interface labels onto T3 skill fields", () => {
  expect(
    parsePiDiscoveredCommands({
      commands: [
        {
          name: "skill:global-review",
          description: "Review changes.",
          source: "skill",
          location: "global",
          interface: {
            displayName: "Global Review",
            shortDescription: "Review diffs.",
          },
        },
      ],
    }),
  ).toEqual({
    skills: [
      {
        name: "global-review",
        description: "Review changes.",
        path: "pi:skill:global-review",
        scope: "user",
        enabled: true,
        displayName: "Global Review",
        shortDescription: "Review diffs.",
      },
    ],
    slashCommands: [],
  });
});

it("parses a standalone /compact command and optional instructions", () => {
  expect(parsePiCompactCommand("/compact")).toEqual({});
  expect(parsePiCompactCommand("  /compact  ")).toEqual({});
  expect(parsePiCompactCommand("/compact keep the auth rewrite")).toEqual({
    customInstructions: "keep the auth rewrite",
  });
  expect(parsePiCompactCommand("/compacted")).toBeNull();
  expect(parsePiCompactCommand("/compact-now")).toBeNull();
  expect(parsePiCompactCommand("please /compact")).toBeNull();
});

it("prepends Pi controls without duplicating discovered commands", () => {
  expect(withPiBuiltinSlashCommands([{ name: "hello", description: "Say hello." }])).toEqual([
    ...PI_BUILTIN_SLASH_COMMANDS,
    { name: "hello", description: "Say hello." },
  ]);
  expect(
    withPiBuiltinSlashCommands([
      { name: "compact", description: "Extension compact." },
      { name: "hello" },
    ]),
  ).toEqual([...PI_BUILTIN_SLASH_COMMANDS, { name: "hello" }]);
});

it.each([
  ["/pi-auto-compaction on", { type: "set_auto_compaction", enabled: true }],
  ["/pi-auto-compaction off", { type: "set_auto_compaction", enabled: false }],
  ["/pi-auto-retry on", { type: "set_auto_retry", enabled: true }],
  ["/pi-auto-retry off", { type: "set_auto_retry", enabled: false }],
  ["/pi-steering-mode all", { type: "set_steering_mode", mode: "all" }],
  ["/pi-steering-mode one-at-a-time", { type: "set_steering_mode", mode: "one-at-a-time" }],
  ["/pi-follow-up-mode all", { type: "set_follow_up_mode", mode: "all" }],
  ["/pi-follow-up-mode one-at-a-time", { type: "set_follow_up_mode", mode: "one-at-a-time" }],
])("maps %s to a native Pi preference", (text, request) => {
  const parsed = parsePiControlCommand(text);
  expect(parsed?.ok).toBe(true);
  if (parsed?.ok) expect(parsed.command.request).toEqual(request);
});

it.each([
  "/pi-auto-compaction",
  "/pi-auto-retry maybe",
  "/pi-auto-retry off extra",
  "/pi-steering-mode later",
  "/pi-follow-up-mode all extra",
])("rejects invalid Pi control arguments: %s", (text) => {
  expect(parsePiControlCommand(text)?.ok).toBe(false);
});

it("does not intercept extension commands or ordinary text", () => {
  expect(parsePiControlCommand("/pi-auto-retry-extra on")).toBeNull();
  expect(parsePiControlCommand("Explain /pi-auto-retry off")).toBeNull();
  expect(parsePiControlCommand("/compact")).toBeNull();
});

it("leaves unrelated dollar-prefixed text unchanged", () => {
  expect(expandPiSkillReference("Explain $HOME", new Set(["global-review"]))).toBe("Explain $HOME");
});

it("hoists every known $ skill and keeps the rest of the prompt", () => {
  expect(expandPiSkillReference("use $alpha then $beta please", new Set(["alpha", "beta"]))).toBe(
    "/skill:alpha /skill:beta use  then  please",
  );
});

it("preserves code indentation and line breaks when expanding a skill", () => {
  expect(expandPiSkillReference("$review\n```ts\n  const x = 1;\n```", new Set(["review"]))).toBe(
    "/skill:review ```ts\n  const x = 1;\n```",
  );
});
