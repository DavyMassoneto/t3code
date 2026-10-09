# Pi Desktop Auto Mode

This dependency-free native Pi package declares the `desktop-auto` runtime policy,
labelled **Auto Mode**. Desktop bundles and loads this extension automatically,
so Desktop users do not need to install it separately. Loading or installing it
does not activate it. Pi Desktop
selects and activates it through its correlated runtime-policy protocol; activation
requires explicit confirmation describing risk-based reviews and extra model calls.

While active, every tool call is reviewed using the current session model through
Pi's native model registry. The reviewer has no tools and receives only the latest
actual user task and bounded action/cwd/source metadata. Only a strict low-risk
approval runs automatically. Risky or uncertain results ask you; denied actions
are blocked with a reason. Other installed extensions remain authoritative, and
their hooks or dialogs are never overridden or auto-answered.

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
a policy is activated.

## Security and limits

Missing model/API/user task, authentication/network failures, invalid or truncated
review output, oversized input, and a 15-second timeout require explicit approval.
No UI, declined/failed confirmations, or stale/cancelled work block execution.
Each call receives a fresh review, without cached approvals. Reviews add model
requests and their associated latency/cost; they do not guarantee safety.

**Automatic approvals are NOT a model autonomous loop or retry mechanism, and
are NOT a security sandbox.** Approved tools can execute arbitrary shell commands,
read or write files, and access the network with the native process's privileges.
