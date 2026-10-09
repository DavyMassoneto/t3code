# Pi Desktop Auto Mode

This dependency-free native Pi package declares the `desktop-auto` runtime policy,
labelled **Auto Mode**. Desktop bundles and loads this extension automatically,
so Desktop users do not need to install it separately. Loading or installing it
does not activate it. Pi Desktop
selects and activates it through its correlated runtime-policy protocol; activation
requires explicit confirmation describing risk-based reviews and extra model calls.

While active, verified built-in routine file operations inside the canonical working
directory can run without model review. Other actions are reviewed using the current
session model through Pi's native model registry. The reviewer has no tools and
receives bounded original-task and recent user follow-up context, proposed action,
cwd, source metadata, and untrusted assistant/tool evidence, excluding hidden thinking.
A bare "continue" does not replace or expand the original authorization. Explicit
low- and medium-risk approvals run automatically; high-risk approvals and `ask`
decisions require explicit confirmation. Denied actions and unavailable reviews
block with guidance to choose a materially safer alternative, not an equivalent
workaround. Other installed extensions remain authoritative, and their hooks or
dialogs are never overridden or auto-answered.

Names-only `ls` and `find` do not inspect file contents. Directory `grep` falls back
to review when its bounded scan encounters protected paths, links, errors, or more
than 2,000 entries, so ordinary repository-root content searches may need review.

## Optional standalone Pi CLI installation

From a checkout's repository root, install the local package with:

```sh
pi install ./extensions/pi-desktop-auto-mode
```

Alternatively, load the native entry point for a single invocation without installing:

```sh
pi --extension ./extensions/pi-desktop-auto-mode/index.mjs
```

No model request is needed to inspect or toggle the native command. This package
has no runtime dependencies and does not need to be published to npm.

## Session controls

For standalone Pi CLI use, `/desktop-auto status`, `/desktop-auto on`, and
`/desktop-auto off` inspect or change the session-local state. When
`T3_PI_POLICY_TOKEN` is set, only status is available through this public command;
Pi Desktop owns activation and deactivation. Native status is also shown when
`ctx.ui.setStatus` is supported. Session changes reset the policy to inactive and
invalidate pending activation confirmations and tool reviews. Stop signals,
shutdown, and deactivation also cancel pending reviews. No settings or environment variables
are changed. In standalone Pi, turning this policy off does not add a permission
gate or disable native tools; Desktop's separate guard owns tool blocking before
a policy is activated. While active, Auto Mode adds guidance to continue authorized
work through completion while respecting explicit restrictions, including
delegation-only and no-direct-edit instructions. It does not expand authorization,
resubmit prompts, or start a separate autonomous loop. Repeated blocked attempts
trigger a bounded per-turn failure breaker that aborts the turn.

## Security and limits

Missing model/API/user task, authentication/network failures, invalid or truncated
review output, oversized input, and a 15-second timeout block nonroutine actions;
they do not trigger repeated confirmation prompts. No UI when confirmation is
required, declined/failed confirmations, or stale/cancelled work block execution.
Nonroutine calls receive fresh reviews, without cached approvals. Reviews add model
requests and their associated latency/cost; routine fastpath calls do not. Neither
review nor canonical-path checking guarantees safety or prevents filesystem races.

**Automatic approvals are NOT a model autonomous loop or retry mechanism, and
are NOT a security sandbox.** This native Pi extension provides no OS isolation.
Approved tools can execute arbitrary shell commands,
read or write files, and access the network with the native process's privileges.
