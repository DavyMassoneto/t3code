import { PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS } from "@t3tools/contracts";

export function shouldRequestWorkspaceDiscovery({
  force,
  inFlight,
  hasCurrentSnapshot,
  key,
  now,
  lastRequest,
  retry,
}: {
  force: boolean;
  inFlight: boolean;
  hasCurrentSnapshot: boolean;
  key: string;
  now: number;
  lastRequest: { key: string; requestedAt: number } | null;
  retry: { key: string; notBefore: number } | null;
}): boolean {
  if (inFlight) return false;
  if (force) return true;
  if (
    lastRequest?.key === key &&
    now - lastRequest.requestedAt < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS
  )
    return false;
  if (hasCurrentSnapshot) return false;
  return retry?.key !== key || now >= retry.notBefore;
}
