# Pi extension runtime policies

Pi keeps the existing RuntimeMode enum. Named policies use `runtimeMode: "auto"` with
`ModelSelection.options: [{ id: "piRuntimePolicy", value: descriptor.id }]`. Built-in Supervised,
Auto-accept edits, and Full access retain their existing tool-hook behavior. A policy does not
disable other installed extensions or auto-answer their UI requests.

## Discovery contract

`get_commands` must contain an entry with `source === "extension"`, name
`pi-desktop-policy-<id>`, and description beginning with `pi-desktop-policy/v1:` followed by
JSON `{ "id": "<id>", "label": "Policy label", "extensionName": "Extension name", "description": "Optional description" }`.
IDs are lowercase alphanumeric segments separated by single hyphens, at most 64 characters;
the metadata ID must exactly equal the command suffix. Label and extensionName are required,
nonempty, trimmed strings, each at most 200 characters. Optional description is a nonempty,
trimmed string at most 2,000 characters; the full metadata string is at most 4,096 characters.
Duplicate native command names, including conflicting sources, do not yield a selectable policy.

`parsePiRuntimePolicies` reads the raw catalog without running commands or injecting the MCP
bridge into discovery. Templates, skills, and ordinary `/auto` commands are not policy declarations.
`ServerProvider.runtimePolicies` reports machine discoveries; workspace snapshots override them
when present, including an authoritative empty list. The adapter always validates against the
live catalog, not the discovery snapshot. Project-only selections remain Auto in the runtime
resolver even when the machine snapshot does not advertise Auto.

## Bundled Auto Mode

Desktop automatically bundles and loads Pi Desktop Auto Mode as a separate native
extension. Its policy ID is `desktop-auto`, its label is `Auto Mode`, and its native
command `pi-desktop-policy-desktop-auto` advertises the discovery descriptor through
`get_commands`. Discovery loads this extension without injecting the MCP bridge.

Loading the extension leaves it passive and inactive. Activation confirms risk-based
reviews and extra model calls, not blanket tool access. Every active `tool_call` uses
the current session model through native `ctx.modelRegistry.streamSimple`, without
reviewer tools. Only strict JSON `approve` plus `low` runs automatically; risky or
uncertain actions require explicit confirmation and `deny` blocks with a reason.
The reviewer receives only the latest actual user task and bounded proposed action,
cwd, and tool source metadata, never assistant/tool text as user authorization.
Missing context/API/model, malformed or incomplete results, oversized input, and a
15-second review timeout fall back to confirmation, never automatic approval. No UI,
declined/failed confirmations, and cancelled or superseded work block execution.
Stop signals, session changes, shutdown, and deactivation invalidate pending reviews.
Other extensions' hooks and dialogs remain authoritative and are not auto-answered.
State is session-local. Reviews are not a safety guarantee, autonomous loop, retry
mechanism, or security sandbox.

Standalone CLI usage, optional installation, and security limits are documented in
`extensions/pi-desktop-auto-mode/README.md`.

## Activation protocol

The adapter dispatches a command-only RPC prompt:

```text
/pi-desktop-policy-<id> activate <requestId>
/pi-desktop-policy-<id> deactivate <requestId>
```

The handler must report completion via `ctx.ui.notify` with prefix `PI_DESKTOP_POLICY_ACK:`
and JSON `{ "requestId": "<requestId>", "policyId": "<id>", "action": "activate", "success": true }`.
Deactivation uses `action: "deactivate"`. Only a boolean positive ACK matching request ID, policy
ID, and action succeeds. Emit `success: false` on rejection or failure. A successful RPC prompt
response alone is insufficient, because Pi may catch extension handler errors and still report
the command handled. The ACK and RPC completion must arrive within 15 seconds of idle waiting.
The deadline pauses while a legitimate extension UI request is awaiting the user, and starts a
fresh bounded wait after the user responds. Stop cancels the dialog and retires the session.

ACK notifications are reserved control messages consumed by the adapter's single event pump;
they are not conversation messages or visible work-log notifications. ACK coordination occurs
before the event permit used for turn publication, so real confirm/input/select/editor dialogs
can travel to the UI and receive responses while activation waits.

The injected bridge starts Auto with every tool blocked. Its private command
`t3-pi-runtime-policy-state <sessionToken> <mode> <policyId-or-dash> <requestId>` updates that
guard and emits `PI_DESKTOP_POLICY_GUARD_ACK:` with the same correlation shape. The adapter
checks the exact live extension registration before dispatch. It blocks first, obtains the old
policy's deactivation ACK, obtains the new policy's activation ACK, then enables delegation.
Neither control command is a model tool or a user slash command. Raw reserved commands are
rejected in both turn start and steering; an unsolicited deactivation ACK for the active policy
retires the process so a stale bridge marker cannot silently bypass approvals. Missing commands, ambiguous declarations, negative
ACKs, invalid/missing selection, and timeouts fail the turn and retire the native process instead
of sending the user message or falling back to another policy. Restart the session to retry.

## Extension responsibilities and limits

See `apps/server/examples/pi-runtime-policy.ts` for a standalone native Pi extension with ID
`example-auto`. Load it as a normal Pi extension. It asks before activation, allows reads/edits,
and confirms other tools. It writes no settings and resets on `session_start`. Extensions must
activate and deactivate only session-local state, reset on native session changes, and send ACK
only after the requested state is established. The adapter invalidates its active policy on
new-session, resume, and fork operations and requires fresh activation before the next turn.

Metadata and ACKs are an opt-in compatibility protocol, not a signature or sandbox. Installed Pi
extensions share one trusted process and can emit notifications or execute code outside tools.
The session token prevents accidental/manual guard updates; it does not isolate hostile extensions.
Other extension tool hooks still apply after the bridge delegates to the selected policy.
