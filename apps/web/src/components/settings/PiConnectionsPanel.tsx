import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type PiConnectionsResult,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listPiConnections } from "../../state/piConnections";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PiConnectionCredentialsForm({
  environmentId,
  instanceId,
  service,
  canManage,
  onSaveApiKey,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly service: string;
  readonly canManage: boolean;
  readonly onSaveApiKey: (apiKey: string) => Promise<boolean>;
  readonly onSaved: () => void;
}) {
  const target = JSON.stringify([environmentId, instanceId, service]);
  const emptyDraft = { target, apiKey: "", consent: false, busy: false, status: "" };
  const [draft, setDraft] = useState(emptyDraft);
  const visibleDraft = draft.target === target && canManage ? draft : emptyDraft;
  const generation = useRef(0);
  const savingTarget = useRef<string | null>(null);
  const activeTarget = useRef(target);
  const allowed = useRef(canManage);
  activeTarget.current = target;
  allowed.current = canManage;
  useEffect(() => {
    savingTarget.current = null;
    activeTarget.current = target;
    allowed.current = canManage;
    setDraft({ target, apiKey: "", consent: false, busy: false, status: "" });
    return () => {
      generation.current += 1;
      activeTarget.current = "";
      allowed.current = false;
    };
  }, [target, canManage]);
  const submit = async () => {
    if (
      !canManage ||
      activeTarget.current !== target ||
      !allowed.current ||
      !visibleDraft.consent ||
      !visibleDraft.apiKey.trim() ||
      visibleDraft.busy ||
      savingTarget.current === target
    )
      return;
    savingTarget.current = target;
    const requestGeneration = ++generation.current;
    const apiKey = visibleDraft.apiKey.trim();
    setDraft({ target, apiKey: "", consent: false, busy: true, status: "" });
    let saved = false;
    try {
      saved = await onSaveApiKey(apiKey);
    } catch {
      saved = false;
    }
    if (
      requestGeneration !== generation.current ||
      activeTarget.current !== target ||
      !allowed.current
    )
      return;
    savingTarget.current = null;
    setDraft({
      target,
      apiKey: "",
      consent: false,
      busy: false,
      status: saved
        ? "API key saved. Refreshing native configuration…"
        : "Could not save the API key. Check this runtime and try again.",
    });
    if (saved) onSaved();
  };
  return (
    <form
      aria-label={`${service} API key configuration`}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="block space-y-2 text-sm">
        <span>API key</span>
        <Input
          type="password"
          autoComplete="off"
          aria-label={`${service} API key`}
          value={visibleDraft.apiKey}
          disabled={!canManage || visibleDraft.busy}
          onChange={(event) => setDraft({ ...visibleDraft, target, apiKey: event.target.value })}
        />
      </label>
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          aria-label="Consent to store or replace API key"
          checked={visibleDraft.consent}
          disabled={!canManage || visibleDraft.busy}
          onChange={(event) => setDraft({ ...visibleDraft, target, consent: event.target.checked })}
        />
        <span>
          I consent to storing or replacing this service's API key in the selected runtime's native
          credential store. Other services' credentials are preserved.
        </span>
      </label>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={
          !canManage || !visibleDraft.consent || !visibleDraft.apiKey.trim() || visibleDraft.busy
        }
      >
        {visibleDraft.busy ? "Saving…" : "Save API key"}
      </Button>
      {visibleDraft.status ? (
        <p role="status" className="text-sm text-muted-foreground">
          {visibleDraft.status}
        </p>
      ) : null}
    </form>
  );
}

export function usePiConnections(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | null,
) {
  const canManage = useAtomValue(listPiConnections.permissionAtom(environmentId));
  const list = useAtomCommand(listPiConnections, { reportFailure: false });
  const [snapshot, setSnapshot] = useState<{
    environmentId: EnvironmentId;
    result: PiConnectionsResult;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!canManage || instanceId === null) return;
    const requestGeneration = ++generation.current;
    setBusy(true);
    setFailed(false);
    const response = await list({ environmentId, input: { instanceId } });
    if (requestGeneration !== generation.current) return;
    setBusy(false);
    if (response._tag === "Success" && response.value.instanceId === instanceId) {
      setSnapshot({ environmentId, result: response.value });
    } else {
      setFailed(true);
    }
  }, [canManage, environmentId, instanceId, list]);
  useEffect(() => {
    setSnapshot(null);
    setFailed(false);
    setBusy(false);
    if (canManage) void refresh();
    return () => {
      generation.current += 1;
    };
  }, [canManage, refresh]);
  const result =
    snapshot?.environmentId === environmentId &&
    snapshot.result.instanceId === instanceId &&
    canManage
      ? snapshot.result
      : null;
  return { canManage, result, busy, failed, refresh };
}

export function PiConnectionDetails({
  connection,
  models,
  credentials,
}: {
  readonly connection: PiConnectionsResult["connections"][number];
  readonly models?: ReactNode;
  readonly credentials?: ReactNode;
}) {
  return (
    <section className="space-y-4" aria-label={`${connection.name} provider details`}>
      <div>
        <h3 className="text-base font-medium">{connection.name}</h3>
        <p className="text-xs text-muted-foreground">{connection.service}</p>
      </div>
      <p className="text-sm">
        {connection.configured ? "Configured" : "Not configured"}
        {connection.authSource ? ` · ${connection.authSource.replaceAll("_", " ")}` : ""}
      </p>
      <div className="space-y-2 text-sm text-muted-foreground">
        <h4 className="font-medium text-foreground">Authentication</h4>
        <p>
          {connection.authMethods
            .map((method) => (method === "oauth" ? "OAuth" : "API key / ambient credentials"))
            .join(", ") || "Managed by the native provider configuration"}
        </p>
        <p>
          Open Pi in the selected environment using this runtime's agent directory, then use /login
          for supported sign-in methods. Custom providers and API keys are configured in Pi. Refresh
          connections here afterward. Desktop does not start browser sign-in or validate
          credentials.
        </p>
        {credentials}
      </div>
      {models ?? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Models</h4>
          {connection.models.length === 0 ? (
            <p className="text-sm text-muted-foreground">No models discovered.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {connection.models.map((model) => (
                <li key={model.slug} className="py-2 text-sm">
                  {model.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    {model.slug} · {model.available ? "Available" : "Not available"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function PiConnectionsPanel({
  environmentId,
  instanceId,
  compact = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly compact?: boolean;
}) {
  const { canManage, result, busy, failed, refresh } = usePiConnections(environmentId, instanceId);
  if (!canManage)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Native Pi connections require providers:manage permission.
      </p>
    );
  const connections = result?.connections ?? [];
  const configured = connections.filter((connection) => connection.configured);
  const disconnected = connections.filter((connection) => !connection.configured);
  const renderConnection = (connection: PiConnectionsResult["connections"][number]) => (
    <div
      key={connection.service}
      className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border/60 p-3"
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">
          {connection.name}{" "}
          <span className="font-normal text-muted-foreground">({connection.service})</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {connection.configured ? "Configured" : "Not configured"}
          {connection.authSource ? ` · ${connection.authSource.replaceAll("_", " ")}` : ""}
          {connection.authMethods.length > 0
            ? ` · supported auth: ${connection.authMethods.map((method) => (method === "oauth" ? "OAuth" : "API key / ambient credentials")).join(", ")}`
            : ""}
        </p>
        {!compact ? (
          <p className="text-xs text-muted-foreground">
            {connection.models.filter((model) => model.available).length} available models ·
            authentication managed in Pi
          </p>
        ) : null}
      </div>
    </div>
  );
  return (
    <section className="space-y-3 p-4" aria-label="Pi native model-service connections">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Native model-service connections</h3>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Discovering…" : "Refresh connections"}
        </Button>
      </div>
      {!compact ? (
        <p className="text-xs text-muted-foreground">
          Pi is the harness. These are its native model services, including custom providers.
          Authentication remains managed by the native Pi CLI: open pi, then /login, using this
          instance's environment and agent directory. Login is not a Desktop chat command. Refresh
          here afterward. Discovery uses Pi's local catalog; it does not validate credentials or
          interrupt active sessions.
        </p>
      ) : null}
      {failed ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connections could not be discovered. Check this instance in Pi 1.1 or newer and refresh.
        </p>
      ) : null}
      {configured.map(renderConnection)}
      {result && configured.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No configured native model services were discovered.
        </p>
      ) : null}
      {!compact && disconnected.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Other native services ({disconnected.length})
          </summary>
          <div className="mt-3 space-y-2">{disconnected.map(renderConnection)}</div>
        </details>
      ) : null}
    </section>
  );
}
