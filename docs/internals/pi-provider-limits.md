# Native Pi Provider Limits

`server.listPiConnections` accepts `includeLimits: true` for an explicit limits refresh. Without
that flag, discovery remains metadata-only. `limitsDetails` carries an ISO `checkedAt`, a static
source identifier, a capability status, and only normalized numeric metrics. The legacy `limits`
field is retained for older clients; when limits are requested it mirrors `limitsDetails.status`.
No quotas are inferred from transcripts or token costs. Permission, selected-instance environment,
native project trust, startup-dialog cancellation and generated-extension provenance follow the
existing Pi connection service.

## Verified Sources And Semantics

- Venice's [Rate Limits and Balances](https://docs.venice.ai/api-reference/endpoint/api_keys/rate_limits)
  OpenAPI (version `20261008.022916`) specifies Bearer-authenticated GET
  `https://api.venice.ai/api/v1/api_keys/rate_limits`. `data.balances.USD` and `DIEM` retain
  their respective units; `BUNDLED_CREDITS` is denominated in USD. `rateLimits[].rateLimits[]`
  describes configured RPM/RPD/TPM capacity, not consumption; those fields are deliberately omitted
  from the limits result. Only monetary and credit balances are returned.
- OpenAI's public [backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)
  specifies GET `/wham/usage` under the ChatGPT backend with Bearer; its
  [header builder](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)
  adds `ChatGPT-Account-Id` only when native routing metadata is present. The alternate
  `/api/codex/usage` path is selected for a different configured backend base URL; it does not
  establish that `api.openai.com/v1/api/codex/usage` exists.
  Its [payload mapping](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)
  preserves `used_percent`, `limit_window_seconds`, epoch-second `reset_at`, and numeric-string
  credit balance. Installed Pi's `openai-codex` provider uses that backend and extracts the account
  claim from OAuth tokens. The distinct new `openai` provider resolves auth using native
  `getProviderAuth("openai")`, not a Codex credential store or model-configured headers.
  OpenAI's [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
  confirms issuer `https://auth.openai.com`, audience `https://api.openai.com/v1`, scope
  `chatgpt.tokens.use.direct`, and opaque `encrypted_auth_metadata`. Do not decrypt that metadata
  or invent an account ID. Native auth routing headers take precedence; legacy explicit account
  claims are the fallback. Otherwise the request omits the optional account header.
  The approved live diagnostic on October 8, 2026 returned
  `{status: error, authType: oauth, httpStatus: 401, metricCount: 0}` for the selected native
  direct-token profile. Ordinary limits refresh never repeats this rejected direct-token request.
  It instead uses a separately authorized native `openai-codex` OAuth credential when present in
  the selected Pi profile, or reports that quota authorization is required. This is not evidence
  that the direct token works. No alternate endpoint or external credential store is tried.
  Direct-token acceptance is not guaranteed by public docs:
  the official [account processor](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/account_processor.rs)
  gates its quota RPC on `uses_codex_backend()`, and the direct-token
  [DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/packages/local/src/index.ts)
  supplies a ChatGPT usage-management link, not a quota-fetch API. Offline fixtures verify native
  auth resolution, fixed request semantics and wire projection, not actual provider acceptance.
- Anthropic's published [Claude Code 2.1.0 client](https://unpkg.com/@anthropic-ai/claude-code@2.1.0/cli.js)
  implements GET `https://api.anthropic.com/api/oauth/usage` with Bearer OAuth and
  `anthropic-beta: oauth-2025-04-20`, with a five-second request timeout. This is a private API,
  not the platform Rate Limits API. Its API utilization fields are percentages, not the fractional
  utilization supplied in inference response headers. Current native extension source
  [pi-usage](https://github.com/mtrojnar/pi-usage/blob/main/src/anthropic.ts) independently uses the
  same headers and percentage semantics. The current official npm client `2.1.295` no longer
  exposes `cli.js`, so this is not a claim to have inspected that version's implementation.
  Only recognized five-hour and weekly subscription windows are projected; extra-usage financial
  fields are omitted because their units are not established here.

Provider ID alone never authorizes a probe. Built-in adapters require matching model and provider
base URLs and native OAuth/API-key mode, then validate the resolved auth base URL too. No raw auth
headers, tokens, response bodies, exception text or provider diagnostic source labels cross RPC.
Redirects are refused. Three waiting worker slots use five-second per-provider and twelve-second
aggregate deadlines. A plugin that ignores its signal may keep work running after its slot times out;
these are not a strict limit of three active uncooperative probes. The scoped native child is stopped
when discovery ends, containing that work. Response parsing is limited to one megabyte. A failed supported probe yields
`error`; unsupported API-only/custom services yield `unsupported`; recognized loopback locals yield
`not_applicable`. Missing metric values are omitted, not replaced with zero.

## Opt-In Extension Protocol

Installed Pi's provider interface has no usage/quota hook. Extensions may subscribe to the existing
native event bus channel `t3:provider-limits:collect` and synchronously call
`request.register(service, async ({ signal }) => ({ metrics }))` when `request.version === 1`.
Registration occurs only during an explicit limits refresh and must match a discovered provider.
The registered reader executes inside native Pi and must honor the AbortSignal. Its own native
provider integration resolves credentials; the server does not supply them. Do not read another
harness's credentials or log account material. This is a T3 extension protocol, not a Pi SDK API.

Metrics support finite `used`, `limit`, `remaining`, nonnegative `windowSeconds`, canonicalized
`resetsAt`, and units `percent`, `USD`, `DIEM`, `credits`, `requests`, `tokens`. The bridge generates
public metric IDs/labels and discards arbitrary plugin labels, IDs, messages, sources and headers.
Only actual values reported by the plugin's verified source belong here. Percent metrics may include
`limit: 100`; configured rates must not manufacture remaining consumption. No metrics means
`unsupported`. Exceptions are mapped to a fixed safe `error` message.

`apps/server/examples/pi-provider-limits.ts` is a working, network-free protocol fixture registering
`t3-limits-fixture`. Its balance is explicitly synthetic. Load it as a Pi extension only for protocol
development; the scoped native-limits test runs the same fixture. Existing `pi-claude` and other
extensions do not implement this protocol automatically.

## Native Subscription Quota Authorization

The Pi driver registers `pi-openai-quota-device` through the existing ProviderAuth RPCs.
`provider.auth.start` takes `{instanceId, methodId: "pi-openai-quota-device"}`; subscribe publishes
the existing `deviceCode` interaction (`id`, fixed `url`, `userCode`). Cancel uses the existing
flow ID. The caller explicitly starts sign-in; no unattended authorization or browser automation
is performed. The native installed SDK chooses its `device_code` login method and performs the
official OpenAI device authorization and token exchange. The controller lifetime is five minutes.

Only the native child sees tokens. It stages login in `AuthStorage.inMemory()` and saves the
result to `openai-codex` in the selected Pi profile via the SDK after checking cancellation.
It never rewrites the direct `openai` credential or imports another application's store.
The instance registry scope owns the pending login; closing/replacing that scope interrupts it
and tears down the child. Quota sign-in/out deliberately ignores generic inference-session
teardown callbacks and does not expose an inference `withAccess` gate.

Limits reads check credential metadata in that same native store and use public refresh-aware
`ModelRuntime.getAuth("openai-codex", {signal})`. This also works when the discovery extension's
registry has no legacy inference models. Fixed official native provider metadata is validated
before resolving auth. Explicit extension usage readers retain priority. A single OpenAI row
uses source `native-openai-separate-quota-oauth`, clearly labels the separately authorized
subscription, and preserves any sanitized failure reason. It does not claim automatic account
identity matching; the direct OAuth metadata is opaque. The duplicate legacy quota row is removed.
Offline tests and installed SDK metadata confirm compatibility, not real account acceptance.

## Optional Live OpenAI Diagnostic

`apps/server/scripts/pi-openai-limits-diagnostic.ts` makes no account request without exactly
`--live-probe` and explicit `PI_BINARY_PATH` (absolute selected native executable) and
`PI_CODING_AGENT_DIR` (selected native profile). It never reads credentials outside native Pi.
An approved probe may cause the native SDK's normal OAuth refresh/persistence. Inherit the selected
instance's environment; optionally supply its launch arguments in `PI_DIAGNOSTIC_LAUNCH_ARGS`
and absolute working directory in `PI_DIAGNOSTIC_CWD`. No profile directory is inferred.

The same generated bridge is restricted to native `openai`; opt-in plugin collection is disabled.
It resolves the selected native SDK/profile and prefers the same separate quota OAuth path used
by ordinary refresh. No quota login means no direct-token request by default. The explicit extra
flag `--direct-token-probe` selects the historical rejected direct-token check instead; do not use
that flag to verify the new quota login.
The diagnostic command's wire payload contains only `status`, known `authType`, optional numeric
`httpStatus`, and `metricCount`. It does not emit tokens, headers, account IDs, response bodies,
source URLs, quota values or balances. Child stdout/stderr diagnostics are consumed without being
printed, and Effect logging is disabled. Any startup dialog cancels without answering it. Work has
a twenty-second deadline; scoped teardown stops the captured Pi child/process tree and removes
temporary extension files. No tools/session persistence or alternate harness are enabled.

From the repo root, after obtaining explicit approval for the account read:

```powershell
$env:PI_BINARY_PATH = '<selected absolute native Pi binary>'
$env:PI_CODING_AGENT_DIR = '<selected native agent directory>'
$env:PI_DIAGNOSTIC_LAUNCH_ARGS = '<selected native launch arguments, or empty>'
node apps/server/scripts/pi-openai-limits-diagnostic.ts --live-probe
```

`available` with a positive `metricCount` verifies that the tested native token was accepted for this
private quota payload. HTTP 401/403 does not justify guessing another endpoint, trying another
harness store, or shipping a fake quota. The `/api/codex/usage` branch in the official client belongs
to its configured Codex backend base, not to the inference audience `https://api.openai.com/v1`;
there is no verified production fallback host for the direct Pi token in the sources above.
