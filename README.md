# T3 Code - Pi GUI

This fork uses **Pi as its coding-agent harness**, with T3 Code's graphical workspace around it. Pi owns model access, authentication, extensions, skills, context loading, and native conversation history. T3 Code adds project and thread management, approvals, Git workflows, terminals, previews, remote access, and subagent coordination.

Pi is the harness, not a single model service. Choose among the model providers authenticated and configured in Pi; separate Codex, Claude Code, Cursor, or other agent CLIs are not required for this fork.

The repository retains T3 Code's web, Electron desktop, and mobile clients. Desktop build targets include Windows, macOS, and Linux. Not every native Pi terminal feature already has a graphical equivalent: see [Pi setup and graphical limitations](./docs/user/providers-pi.md).

## Install and authenticate Pi

Install Pi on the machine that runs the T3 Code server, not just on a remote client. The adapter requires Pi **0.80.5 or newer**.

With npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
pi
```

In Pi, run `/login` and select your model provider, or supply the provider's API-key environment variable. Pi's stored credentials normally live in `~/.pi/agent/auth.json`. Keep that file private. Configure Pi in T3 Code Settings and refresh it; if the server cannot find `pi`, set its binary path explicitly.

On native Windows, Pi's Bash tool needs a working Bash installation, typically Git Bash. Pi also documents a Windows-native PowerShell tool. A Pi installation inside WSL belongs to that Linux environment; a Windows server does not automatically share its executable, credentials, or paths.

See [Pi setup](./docs/user/providers-pi.md) for configuration, sessions, permissions, and troubleshooting.

## Run this fork from source

Use the Node.js version supported by this repository (`^24.13.1`) and install Vite+ (`vp`). Pi itself requires Node.js 22.19 or newer when installed through npm.

Install Vite+ on macOS or Linux:

```bash
curl -fsSL https://vite.plus | bash
```

On Windows, in PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

From the repository root:

```bash
vp i
vp run dev --home-dir .t3/pi-gui
```

For desktop development, use `vp run dev:desktop --home-dir .t3/pi-gui`. The explicit home directory keeps this checkout's runtime state separate from an installed T3 Code app. See [internal overview](./docs/internals/overview.md) for build details and [CONTRIBUTING.md](./CONTRIBUTING.md) for repository conventions.

Upstream T3 Code installers, npm releases, and app-store downloads are not distributions of this fork. Use a build of this checkout when you want the Pi-only product.

## What carries over

- **Pi configuration:** model discovery and thinking levels, custom model endpoints, user/project instructions, prompt templates, skills, and extensions supported in RPC mode.
- **Native history:** native Pi v3 JSONL discovery and import are implemented. They respect `PI_CODING_AGENT_DIR` and read source sessions without modifying them; imported threads use the absolute JSONL path for resume, not the header UUID. Rollback and thread forks preserve native conversation boundaries. A complete native session picker, branch-tree browser, and Pi export workflow remain gaps.
- **T3 workflows:** projects and worktrees, Git diffs and pull requests, integrated terminals, browser previews, attachments, and durable delegated child threads.
- **Remote use:** a server-side Pi process can be controlled through the retained T3 clients. Credentials and workspace files stay with the server environment.

Pi's terminal settings menu, session picker, and custom terminal extension components do not yet have complete graphical equivalents. The composer exposes native compaction, automatic compaction/retry, and queue-delivery controls; these execute Pi RPC operations rather than model prompts. Do not assume every Pi terminal built-in works in the composer. See the [graphical limitations](./docs/user/providers-pi.md#graphical-limitations) before relying on a native Pi workflow.

Pi's automatic retry preference does not disable T3's Stop or steering controls. Turning retries off does not stop the current turn, and enabling them does not guarantee successful recovery. See [Native Pi controls](./docs/user/providers-pi.md#native-pi-controls) for usage.

Pi keeps the three permission modes: **Supervised**, **Auto-accept edits**, and **Full access**. Extension policies are opt-in additions, not a fourth runtime mode or Pi's automatic retry setting. An arbitrary `/auto` command is not discovered as a policy. A plugin must register an extension command named `pi-desktop-policy-<id>` with a description starting with `pi-desktop-policy/v1:` followed by JSON metadata (`id`, `label`, `extensionName`, and optional `description`); the metadata ID must match the command suffix. Its handler accepts `<activate|deactivate> <requestId>` and must notify `PI_DESKTOP_POLICY_ACK:` followed by JSON containing the matching `requestId`, `policyId`, `action`, and boolean `success`. A handled command alone does not establish success; a negative ACK means the plugin rejected the transition.

## Verify Pi integration

`vp test run apps/server/src/provider/PiCommands.test.ts apps/server/src/orchestration-v2/Adapters/PiAdapterV2.test.ts` checks command routing and session behavior. Native discovery, transcript parsing, and import are covered by `apps/server/src/project/AgentSessionScanner.test.ts`, `apps/server/src/project/AgentSessionTranscript.test.ts`, and `apps/server/src/project/AgentSessionImporter.test.ts`. Pi-only registry behavior is covered by `apps/server/src/provider/ProviderInstanceRegistryHydration.test.ts` and `apps/server/src/provider/AcpRegistryCatalog.test.ts`. With Pi 1.1.0 installed, `vp run test:pi-native` exercises the real RPC transport and reversible native preference updates in an isolated `.t3/pi-native-smoke/agent` directory. It does not send model prompts or require credentials. The Pi Core workflow is configured to run focused integration tests and this native smoke on Windows, macOS, and Linux; the matrix is not evidence that those platform runs have completed successfully.

Run `node apps/server/scripts/pi-policy-native-smoke.ts` from the repository root for the offline extension-policy sidecar. It creates and cleans up its own temporary extension under `.t3/pi-policy-native-smoke`, disables extension autoload while explicitly loading that fixture, and uses an isolated agent directory and credential-free environment. It verifies native command metadata, opt-in discovery (excluding arbitrary `/auto`), activation/deactivation and negative ACKs, and absence of agent/model turns. The fixture changes only a session-local boolean, not settings. This transport-level smoke does not establish full graphical parity, production plugin behavior, or completed cross-platform verification.

## User documentation

- [Pi installation, authentication, sessions, and limitations](./docs/user/providers-pi.md)
- [Composer](./docs/user/composer.md) and [thread sidebar](./docs/user/thread-sidebar.md)
- [Project settings and worktrees](./docs/user/project-settings.md)
- [Source control integrations](./docs/user/source-control.md)
- [Integrated terminal](./docs/user/terminal.md)
- [Remote access](./docs/user/remote-access.md)
- [Appearance](./docs/user/appearance.md) and [keyboard shortcuts](./docs/user/keybindings.md)

Some inherited guides still describe upstream multi-harness behavior. The Pi guide is authoritative for this fork's harness setup and permission behavior; other harness-specific guides are not setup instructions for this product.
