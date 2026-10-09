# Pi

Pi is the coding-agent harness for this fork. T3 Code uses your server-side Pi installation and
keeps Pi's models, authentication, extensions, skills, context files, and native session history.
Model providers configured inside Pi are not separate T3 agent harnesses.

## Set Up Pi

1. Install Pi on the machine running the T3 Code server. The adapter requires 0.80.5 or newer.
   For an npm installation, use Node.js 22.19 or newer:

   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   pi --version
   pi
   ```

2. In Pi's terminal interface, run `/login` and select a model provider. Alternatively, supply
   that provider's API-key environment variable, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
   Pi saves interactive credentials in its agent directory's `auth.json`; keep it private.
3. Open Settings > Providers and select the execution environment. If it has multiple Pi
   configurations, select the intended advanced runtime configuration.
   Configure the executable, environment and launch arguments under Advanced > Runtime settings,
   then refresh connections. For a background service, ensure the service
   account can access the same executable, agent directory, and credentials.

Native Windows installations normally use Git Bash for Pi's Bash tool; install Git for Windows
or configure Pi's `shellPath`. Pi also supports an optional native Windows PowerShell tool.
When using WSL, run Pi and the T3 server in the intended Linux environment rather than assuming
Windows and WSL share executables, credentials, or filesystem paths. macOS and Linux installations
likewise need Pi and the shell it uses available to the server process.

If `pi` is not on the server's `PATH`, set Pi's binary path to the executable. Provider environment
variables and launch arguments are also available for installations that need custom configuration.
Set `PI_CODING_AGENT_DIR` to use a different agent directory. Configure compatible endpoints and
model overrides in Pi's `models.json`. `--provider` must be paired with `--model`. T3 Code
rejects launch arguments that change Pi's execution mode or select a session because T3 owns those
parts of the process lifecycle.

Pi's agent directory defaults to `~/.pi/agent`, including `settings.json`, `models.json`,
`auth.json`, extensions, skills, and prompt templates. Trusted project configuration lives under
the workspace's `.pi` directory. Pi also loads applicable context files such as `AGENTS.md` from
the workspace and its parents. Approve project resources in Pi before expecting them to load in
T3 Code. Setting up Pi on a phone or another client does not configure the remote server.

## Native Connections and Packages

Open Settings > Providers and select a native model service, including services supplied by
plugins and custom providers. Its details show discovered models, supported authentication methods
and the configured credential source. Use the environment and runtime configuration selectors
when you have multiple installations. Pi remains the runtime, not an extra model-service provider.
Connection discovery uses the selected runtime's environment, including `PI_CODING_AGENT_DIR`, and Pi's local model
catalog. “Configured” means Pi found authentication configuration, not that credentials were
validated against the service.

For model-provider OAuth, open `pi` with the same environment and agent directory as the selected
runtime, use `/login` there, then refresh connections in settings.
Add provider opens a searchable catalog of disconnected native services. Select a service to
configure it; selecting alone does not connect an account. For services supporting API keys,
enter the key and explicitly consent to storing or replacing it in the selected runtime's native
credential store. Other services' credentials are preserved. Refresh discovery to see the configured
source. Model-authentication OAuth sign-in remains in the native Pi CLI; `/login` is not a Desktop
chat command. OpenAI subscription usage has a separate device-code sign-in described below.
The provider list contains configured services and any service you are currently configuring.
Each service's model controls affect its visibility, favorites and ordering in the app's model
picker, without stopping the shared runtime or deleting credentials. Custom model slugs must use
that service's `service/model` prefix. Usage reports actual tokens and
reported or priced costs from native Pi JSONL sessions, attributed to their model service.
Subscription limits are separate from session usage and depend on the service's supported native
integration. Token counts and costs are not used to infer a subscription quota or balance.
Settings discovery reads the local catalog without requesting account limits.

Refresh limits for the selected Pi instance to request account information. Venice reports actual
USD, DIEM and bundled-credit balances, not configured model RPM/TPM rates.
Anthropic OAuth reports subscription utilization and reset windows.
Legacy native `openai-codex` OAuth requests subscription windows and any credit balance.
Those OAuth integrations use private provider APIs and may stop working after provider changes.
An approved probe of the selected native `openai` direct OAuth connection returned HTTP 401
from the subscription quota API; refresh never repeats that direct-token request.
Use **Connect OpenAI usage** in Usage > Limits or the selected OpenAI service in Settings > Providers
to authorize native Pi's separate quota-compatible
`openai-codex` login. Open the displayed OpenAI device page and approve the code using the
intended subscription account. Direct OpenAI inference authentication stays unchanged.
After native sign-in is confirmed, the app refreshes limits to read actual subscription windows
and any returned credit balance. Authorization alone does not guarantee the account reports quotas.
The OpenAI row labels this separately authorized subscription; account identity is not
automatically linked to the direct token. No credentials are imported from another application.
Existing native `openai-codex` OAuth in the selected Pi profile can be used without a new login.
API-only subscription checks
and unmodified `pi-claude` plugins are unsupported rather than failed connections.
Local Ollama and llama.cpp, including the loopback `llamacpp-local` service, have no account quota.
Custom endpoints are never probed using a built-in service's account API. Credentials stay inside
the selected native Pi process; normal connection discovery does not resolve them.

Extensions can explicitly implement the limits protocol described in
[native Pi limits](../internals/pi-provider-limits.md). Existing plugins are not automatically
compatible. The example extension is a synthetic protocol fixture, not a real account balance.

Open Settings > Plugins. Installed is the default tab for managing installed packages;
Discover opens the official Pi package gallery. Manage extensions, skills, themes, and prompts
for the selected environment and enabled runtime configuration. Packages are app tools,
not entries in the model-service provider list. Search the gallery, filter by package category,
choose a sort order, and browse result pages with the pagination controls. Package management requires
an npm Pi installation exposing its native SDK. Other installations can use Pi's native CLI.
The shared Settings header selects the destination: All projects uses the selected runtime's global
scope on the selected machine; a project or checkout uses its owning environment's project workspace
root. Ambiguous or unavailable selections cannot manage packages. Installing or
updating a package requires explicit execution consent. Project scope requires the workspace to
already be trusted in native Pi before listing or changing packages; the GUI never grants this
trust implicitly. Changes apply to the next session without stopping active sessions.

## What Carries Over

T3 Code discovers the models reported by Pi and exposes their supported thinking levels. The
new-thread model setting shows Pi's configured native model under its actual service, not a separate
default model. Changing the default in T3 Code updates Pi's native settings at the selected
environment or project scope; clearing a project override restores inheritance. If that model
cannot be discovered, the picker reports the default as unavailable rather than choosing another
catalog model.

The thinking picker marks Pi's current configured level as the default without overriding it. Threads
use Pi's native session files for resume, rollback, and forks within the same Pi instance. Forks
preserve the native conversation through the selected turn in the destination workspace.
Extension dialogs appear in the T3 Code composer, and the composer context meter follows Pi's own usage
reporting while a response streams and after it settles.

Pi skills appear in the composer's `$` menu. This includes user skills and project skills that Pi
loads for the current workspace; selecting one uses Pi's native skill expansion.

Pi loads its normal user and project extensions. Blocking `select`, `confirm`, `input`, and `editor`
dialogs work in T3 Code. Notifications appear in the work log. Pi terminal decoration such as
titles, status lines, and widgets does not have a T3 Code equivalent.

## Permission Modes

T3 Code applies the composer permission mode through Pi's blocking tool hook:

- **Supervised** asks before commands, file changes, and extension tools. Read-only tools continue.
- **Auto-accept edits** allows Pi's edit and write tools, but asks before commands and extension
  tools.
- **Full access** allows tools without T3 Code approval prompts.

Extensions can also offer their own named permission policies. Install a compatible Pi extension,
then choose its policy in the composer's permission picker. The picker identifies the extension
that supplies each policy. Policies can come from your user extensions or extensions loaded for
the current project; installing an arbitrary extension does not make it a permission policy.

An extension must explicitly declare Pi Desktop policy compatibility. T3 Code checks that the
selected policy is available in the live Pi session and waits for the extension to confirm
activation before sending your message. If the extension is missing, rejects activation, or does
not respond in time, the turn fails without sending your message or falling back to Full access.
Resolve the extension error or choose a built-in mode and restart the provider session to retry.

Extension policies use the stored Auto mode, but are not a built-in AI approval reviewer. The
extension decides which tools to allow or ask about. Its confirmation and input dialogs still
require your response; selecting a policy does not automatically approve those dialogs. Older
threads stored as Auto without a policy selection continue to resolve to Supervised when the
provider does not advertise Auto; a live Auto request without a selection fails closed.

Changing a built-in mode restarts the Pi provider session and resumes the same native conversation.
Changing between extension policies deactivates the old policy before activating the new one;
both steps require the extension's confirmation. Policies are session-scoped, so resuming or
switching native sessions requires activation again without changing your Pi settings. The
policy covers Pi tool calls; it is not an operating-system sandbox, and code that a trusted Pi
extension runs outside a tool call remains governed by Pi's own extension trust model.

T3 Code's `delegate_task` tool creates durable child threads in the shared subagent UI. If the user
installs Pi's example `subagent` extension, T3 Code also shows its task progress and results in that
UI. The example runs those children without a session, so they cannot be opened or resumed as T3 Code
threads.

## Sessions and compaction

T3 Code owns the Pi process lifecycle and associates each thread with a native Pi session file.
Pi normally stores JSONL sessions under `~/.pi/agent/sessions`, grouped by working directory.
T3's thread record and Pi's
session file are separate state: preserve both when moving or backing up an environment.

Native Pi v3 JSONL sessions created outside T3 Code can be discovered and imported through T3's
project discovery and import flow. Discovery reads the configured Pi agent directory's `sessions`
folder. It respects `PI_CODING_AGENT_DIR` in the Pi provider's environment, falling back to the
server process's environment and then `~/.pi/agent`. Set that variable for the Pi instance whose
history you want to import. Discovery and import are read-only for the source session files;
import creates T3 thread records without rewriting Pi history. Imported threads resume using
the absolute path to the native `.jsonl` file, not the UUID in its session header. Keep that file
available on the server to resume the thread. This does not provide a complete native session
picker, branch-tree browser, or Pi HTML/JSONL export workflow.

Resume an existing T3 thread to continue its native conversation. Use T3's rollback or fork
actions for earlier turns. A T3 thread fork creates separate work; it does not expose Pi's entire
in-file branch tree, labels, or session picker. To use Pi's native session picker, run `pi --resume`
in a terminal. Avoid editing the same native session concurrently in Pi and T3 Code.

Send `/compact` in the composer to compact the current conversation, optionally followed by
instructions, for example `/compact Preserve the failing test and the proposed fix`. Compaction
reduces the context sent to the model, not the complete saved session history. Pi's configured
automatic compaction and retry behavior still apply.

The composer can steer an active response and queue later messages using T3's controls. Use
`/pi-steering-mode` and `/pi-follow-up-mode` to choose Pi's queue-delivery setting (`all` or
`one-at-a-time`) for each queue. See [Native Pi controls](#native-pi-controls) for the commands.

## T3 workflows retained

Pi runs inside the existing T3 workspace: projects and worktrees, Git diffs and pull requests,
integrated terminals, attachments, browser previews, remote connections, and delegated child
threads remain available through their T3 surfaces. The bridge exposes T3 tools to Pi without
replacing Pi's own resource loading. Device and preview features still depend on the host and
client capabilities; not every feature is available on every surface.

## Native Pi controls

The composer's command menu includes these explicit Pi preference controls:

| Command               | Values                 | Pi behavior                                        |
| --------------------- | ---------------------- | -------------------------------------------------- |
| `/pi-auto-compaction` | `on`, `off`            | Enable or disable automatic context compaction     |
| `/pi-auto-retry`      | `on`, `off`            | Enable or disable retries for transient failures   |
| `/pi-steering-mode`   | `all`, `one-at-a-time` | Choose how queued steering messages are delivered  |
| `/pi-follow-up-mode`  | `all`, `one-at-a-time` | Choose how queued follow-up messages are delivered |

For example, send `/pi-auto-compaction off`. These GUI convenience commands call Pi's native
RPC operations directly, without sending a prompt to a model or maintaining a separate T3
preference file. Pi's response determines whether the action succeeded, and the result appears
in the work log. During a running turn they change the native preference without sending steering
text to the model or ending the ongoing turn. They do not accept attachments.

`/pi-auto-retry` changes Pi's automatic recovery from transient failures; it does not disable
T3's Stop or steering controls. Turning automatic retry off is not the same as stopping the
current turn. Use Stop to interrupt it or steering to redirect it. Retry recovery can still
fail; enabling it does not guarantee that a turn will complete successfully.

`/compact` remains available for manual compaction, including optional summary instructions.
Model and thinking pickers use Pi's discovered models and supported thinking levels.

## Graphical limitations

The GUI is not yet a complete replacement for Pi's interactive terminal interface:

- **Commands:** Pi exposes extension commands, prompt templates, and skills for discovery.
  Terminal built-ins are not included. `/compact` is explicitly mapped to a native operation;
  use the model/thinking pickers and T3 thread actions for their supported equivalents. Do not
  send `/settings`, `/login`, `/resume`, or `/tree` expecting a native terminal menu to open.
- **Extension UI:** `select`, `confirm`, `input`, and `editor` dialogs are supported; notifications
  appear in the work log during a turn. Extension status, widgets, titles, and requests to set
  composer text are not displayed or applied. Pi itself does not support custom terminal
  components, terminal-input hooks, or theme switching in RPC mode; those extensions need a
  graphical adaptation or Pi's terminal interface.
- **Sessions:** native Pi v3 discovery and import are available, but a complete graphical native
  session picker, full branch-tree navigation, and Pi HTML/JSONL export and sharing workflow
  remain gaps. T3's thread resume, rollback, and fork are not substitutes for all native session
  operations.
- **Runtime preferences:** model selection, supported thinking levels, queue-delivery modes,
  and automatic compaction/retry are exposed, but there is no complete Pi settings editor for
  thinking budgets, tool selection, or model configuration files. Configure those in Pi and
  start a fresh provider session to load changes. T3's appearance and keybindings are separate
  from Pi terminal themes and shortcuts.
- **Resource management:** package search, install, update, and remove are available in Pi provider
  settings when the native package SDK is available. Resource configuration files and native reload
  menus remain terminal workflows. Package changes load in the next session, not active sessions.

Use the terminal interface for native-only workflows. These limits concern the graphical
integration, not whether Pi itself supports the underlying feature.

## Troubleshooting

- If Pi is unavailable, confirm that the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, open Pi directly and confirm its authentication and model configuration.
- If native connection discovery encounters an interactive startup dialog, complete setup in the
  native Pi CLI for that instance, then refresh connections. Discovery does not approve those dialogs.
- If discovery cannot complete, the native default is unavailable in the model picker. Complete
  any startup prompts in Pi's terminal interface, then refresh connections.
- If a project extension is missing, approve the project in Pi, then start a fresh provider session.
- If a project skill is missing from the `$` menu, approve the project in Pi and refresh the provider.
- The context meter appears once Pi reports usage for the thread. Some model providers only
  report usage when a response completes, so the meter can wait for the first reply.
