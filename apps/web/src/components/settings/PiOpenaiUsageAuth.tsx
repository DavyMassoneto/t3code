import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { usePiOpenaiUsageAuth } from "../../state/piOpenaiUsageAuth";
import { Button } from "../ui/button";

export function PiOpenaiUsageAuth(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly service: string;
  readonly onAuthenticated: () => void;
  readonly readOnly?: boolean;
}) {
  const state = usePiOpenaiUsageAuth(props);
  const interaction = state.active ? state.auth?.interaction : null;
  return (
    <section
      aria-label="OpenAI subscription usage authorization"
      className="space-y-2 rounded-lg border border-border/60 p-3"
    >
      <h4 className="text-sm font-medium">OpenAI subscription usage</h4>
      <p className="text-xs text-muted-foreground">
        Connect your ChatGPT account to view subscription usage. This separate sign-in does not
        change your model authentication.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary>About this account</summary>
        <p className="pt-1">
          Sign in to the intended ChatGPT account. Subscription and model accounts are not
          automatically matched or merged. Source: native Pi subscription authorization
          (openai-codex).
        </p>
      </details>
      {!state.allowed ? (
        <p className="text-xs text-muted-foreground">
          Connecting usage requires providers:manage permission.
        </p>
      ) : (
        <>
          {state.active ? (
            <div className="space-y-2">
              <p role="status" className="text-sm">
                {state.auth?.phase === "verifying"
                  ? "Waiting for native account confirmation…"
                  : interaction?.type === "deviceCode"
                    ? "Enter this device code on the native OpenAI sign-in page."
                    : "Starting native subscription sign-in…"}
              </p>
              {interaction?.type === "deviceCode" ? (
                <code aria-label="OpenAI device code" className="select-all text-sm">
                  {interaction.userCode}
                </code>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {interaction?.type === "deviceCode" || interaction?.type === "browser" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={state.pending}
                    onClick={() => void state.openBrowser()}
                  >
                    Open OpenAI sign-in page
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={state.pending || !state.canCancel}
                  onClick={() => void state.cancel()}
                >
                  Cancel sign-in
                </Button>
                <Button size="xs" variant="ghost" disabled={state.pending} onClick={state.refresh}>
                  Check status
                </Button>
              </div>
            </div>
          ) : (
            <>
              {state.supported && state.auth?.phase === "succeeded" ? (
                <p role="status" className="text-sm">
                  Subscription sign-in confirmed.
                </p>
              ) : null}
              {state.auth?.phase === "failed" ? (
                <p role="status" className="text-sm">
                  Native usage sign-in failed or expired. Retry to authorize your subscription
                  account.
                </p>
              ) : null}
              {state.auth?.phase === "cancelled" ? (
                <p role="status" className="text-sm">
                  Native usage sign-in cancelled.
                </p>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={!state.supported || state.pending || state.loading || state.queryFailed}
                onClick={() => void state.start()}
              >
                {state.pending ? "Starting…" : "Connect OpenAI usage"}
              </Button>
              {state.loading ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Reading native usage sign-in status...
                </p>
              ) : null}
              {state.pending ? (
                <p role="status" className="text-sm">
                  Starting native subscription sign-in...
                </p>
              ) : null}
              {!state.loading && !state.supported && !state.queryFailed ? (
                <p className="text-xs text-muted-foreground">
                  This runtime does not advertise native OpenAI usage sign-in.
                </p>
              ) : null}
            </>
          )}
          {state.queryFailed ? (
            <p role="status" className="text-sm">
              {state.queryError}{" "}
              <Button size="xs" variant="ghost" disabled={state.loading} onClick={state.refresh}>
                Retry status
              </Button>
            </p>
          ) : null}
          {state.error ? (
            <p role="status" className="text-sm">
              {state.error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
