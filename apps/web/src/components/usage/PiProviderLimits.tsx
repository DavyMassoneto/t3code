import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type PiConnectionsResult,
  type PiProviderLimits as NativeLimits,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { listPiConnections } from "../../state/piConnections";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { PiOpenaiUsageAuth } from "../settings/PiOpenaiUsageAuth";
import {
  formatNativeMetricValue,
  formatNativeMetricExactValue,
  formatNativeWindow,
  groupPiProviderLimits,
  nativeMetricKind,
  nativeMetricProgress,
  nativeUsageMetrics,
} from "./piProviderLimitsHelpers";

function NativeTimestamp({ value }: { readonly value: string }) {
  const parsed = new Date(value);
  return (
    <time dateTime={value}>{Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()}</time>
  );
}

function LimitsMetadata({ limits }: { readonly limits: NativeLimits }) {
  return (
    <p
      className="truncate text-xs text-muted-foreground"
      title={`Checked ${limits.checkedAt} · Source: ${limits.source}`}
    >
      Checked <NativeTimestamp value={limits.checkedAt} /> · Source: {limits.source}
    </p>
  );
}

export function PiProviderLimits({
  environmentId,
  instanceId,
  contextLabel,
  refreshToken,
  service,
  readOnly = false,
  showUsageAuthorization = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly contextLabel: string;
  readonly refreshToken: number;
  readonly service?: string;
  readonly readOnly?: boolean;
  readonly showUsageAuthorization?: boolean;
}) {
  const allowed = useAtomValue(listPiConnections.permissionAtom(environmentId));
  const list = useAtomCommand(listPiConnections, { reportFailure: false });
  const [authorizationRevision, setAuthorizationRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    environmentId: EnvironmentId;
    instanceId: ProviderInstanceId;
    refreshToken: number;
    authorizationRevision: number;
    result: PiConnectionsResult | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    if (allowed) {
      const load = async () => {
        let result: PiConnectionsResult | null = null;
        try {
          const response = await list({
            environmentId,
            input: { instanceId, includeLimits: true },
          });
          if (response._tag === "Success" && response.value.instanceId === instanceId) {
            result = response.value;
          }
        } catch {
          result = null;
        }
        if (active && readEnvironmentScope(environmentId, AuthProvidersManageScope)) {
          setSnapshot({ environmentId, instanceId, refreshToken, authorizationRevision, result });
        }
      };
      void load();
    }
    return () => {
      active = false;
    };
  }, [allowed, environmentId, instanceId, refreshToken, authorizationRevision, list]);

  if (!allowed) {
    return (
      <p className="text-sm text-muted-foreground">
        {contextLabel}: native limits require providers:manage permission.
      </p>
    );
  }
  const current =
    snapshot?.environmentId === environmentId &&
    snapshot.instanceId === instanceId &&
    snapshot.refreshToken === refreshToken &&
    snapshot.authorizationRevision === authorizationRevision
      ? snapshot
      : null;
  if (!current) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {contextLabel}: loading native provider limits…
      </p>
    );
  }
  if (!current.result) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {contextLabel}: could not refresh native limits. This request failed; retry with Refresh.
      </p>
    );
  }
  const connections = current.result.connections.filter(
    (connection) => !service || connection.service === service,
  );
  const openaiConnection = connections.find(
    (connection) =>
      connection.configured &&
      (connection.service === "openai" || connection.service === "openai-codex"),
  );
  const { available, errors, unsupported } = groupPiProviderLimits(connections);
  if (
    available.length === 0 &&
    errors.length === 0 &&
    unsupported.length === 0 &&
    !openaiConnection
  )
    return null;
  const services = available.map((connection) => ({
    connection,
    metrics: nativeUsageMetrics(connection.limitsDetails!.metrics),
  }));
  const withoutUsage = [
    ...unsupported,
    ...services
      .filter((service) => service.metrics.length === 0)
      .map((service) => service.connection),
  ];

  return (
    <section aria-label={`${contextLabel} native provider limits`} className="space-y-3">
      <h2 className="text-sm font-medium">Balances and usage · {contextLabel}</h2>
      {openaiConnection && showUsageAuthorization ? (
        <PiOpenaiUsageAuth
          key={JSON.stringify([environmentId, instanceId, openaiConnection.service])}
          environmentId={environmentId}
          instanceId={instanceId}
          service={openaiConnection.service}
          readOnly={readOnly}
          onAuthenticated={() => setAuthorizationRevision((revision) => revision + 1)}
        />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {services
          .filter((service) => service.metrics.length > 0)
          .map(({ connection, metrics }) => {
            const limits = connection.limitsDetails!;
            const balances = metrics.filter((metric) => nativeMetricKind(metric) === "Balance");
            const windows = metrics.filter((metric) => nativeMetricKind(metric) !== "Balance");
            return (
              <section
                key={connection.service}
                aria-label={`${connection.name} limits`}
                className="min-w-0 space-y-2 rounded-xl border border-border/60 p-3"
              >
                <h3 className="text-sm font-medium">
                  {connection.name}{" "}
                  <span className="text-xs text-muted-foreground">{connection.service}</span>
                </h3>
                {balances.length > 0 ? (
                  <dl
                    aria-label={`${connection.name} balances`}
                    className="flex flex-wrap gap-x-5 gap-y-2"
                  >
                    {balances.map((metric) => (
                      <div key={metric.id}>
                        <dt className="text-xs text-muted-foreground">{metric.label}</dt>
                        <dd
                          className="text-base font-medium tabular-nums"
                          title={formatNativeMetricExactValue(metric.remaining!, metric.unit)}
                          aria-label={`${metric.label}: ${formatNativeMetricExactValue(metric.remaining!, metric.unit)}`}
                        >
                          {formatNativeMetricValue(metric.remaining!, metric.unit)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {windows.map((metric) => {
                  const progress = nativeMetricProgress(metric)!;
                  const exact = (["used", "limit", "remaining"] as const)
                    .filter((field) => metric[field] !== undefined)
                    .map(
                      (field) =>
                        `${field}: ${formatNativeMetricExactValue(metric[field]!, metric.unit)}`,
                    )
                    .join(" · ");
                  return (
                    <div key={metric.id} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <h4 className="min-w-0 truncate font-medium" title={metric.label}>
                          {metric.label}
                        </h4>
                        <span className="shrink-0 tabular-nums" title={exact}>
                          {progress.label}
                        </span>
                      </div>
                      <meter
                        aria-label={`${metric.label}: ${progress.label}`}
                        title={exact}
                        min={0}
                        max={100}
                        value={progress.percent}
                        className="h-2 w-full"
                      />
                      <p className="text-xs text-muted-foreground">
                        {metric.windowSeconds !== undefined
                          ? `${formatNativeWindow(metric.windowSeconds)} window`
                          : null}
                        {metric.model ? ` · ${metric.model}` : null}
                        {metric.resetsAt ? (
                          <>
                            {" "}
                            · Resets <NativeTimestamp value={metric.resetsAt} />
                          </>
                        ) : null}
                      </p>
                    </div>
                  );
                })}
                <LimitsMetadata limits={limits} />
              </section>
            );
          })}
      </div>
      {errors.map((connection) => (
        <div key={connection.service} role="status" className="space-y-1 text-sm">
          <p>
            {connection.name} ({connection.service}): limits could not be checked. Retry with
            Refresh.
          </p>
          {connection.limitsDetails?.message ? (
            <p className="break-words text-xs text-muted-foreground">
              {connection.limitsDetails.message}
            </p>
          ) : null}
          <LimitsMetadata limits={connection.limitsDetails!} />
        </div>
      ))}
      {withoutUsage.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary>
            {withoutUsage.length} {withoutUsage.length === 1 ? "service did" : "services did"} not
            report balances or subscription usage.
          </summary>
          <p className="break-words pt-1">
            {withoutUsage
              .map((connection) => `${connection.name} (${connection.service})`)
              .join(", ")}
            . Technical API rate capacities are not shown here.
          </p>
        </details>
      ) : null}
    </section>
  );
}
