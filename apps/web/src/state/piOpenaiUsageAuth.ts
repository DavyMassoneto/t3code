import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ensureLocalApi } from "../localApi";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { readEnvironmentScope, useEnvironmentScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const PI_OPENAI_USAGE_AUTH_METHOD = "pi-openai-quota-device";

export function usePiOpenaiUsageAuth({
  environmentId,
  instanceId,
  service,
  onAuthenticated,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly service: string;
  readonly onAuthenticated: () => void;
  readonly readOnly?: boolean;
}) {
  const startAllowed = useAtomValue(
    serverEnvironment.startProviderAuth.permissionAtom(environmentId),
  );
  const cancelAllowed = useAtomValue(
    serverEnvironment.cancelProviderAuth.permissionAtom(environmentId),
  );
  const respondAllowed = useAtomValue(
    serverEnvironment.respondProviderAuth.permissionAtom(environmentId),
  );
  const manageAllowed = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const allowed =
    startAllowed &&
    manageAllowed &&
    !readOnly &&
    (service === "openai" || service === "openai-codex");
  const query = useEnvironmentQuery(
    allowed ? serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }) : null,
  );
  const options = { reportFailure: false, reportDefect: false };
  const startCommand = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const cancelCommand = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const respondCommand = useAtomCommand(serverEnvironment.respondProviderAuth, options);
  const target = JSON.stringify([environmentId, instanceId, service]);
  const currentTarget = useRef(target);
  const permission = useRef(allowed);
  currentTarget.current = target;
  permission.current = allowed;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const ownedFlow = useRef<string | null>(null);
  const observedFlow = useRef<string | null>(null);
  const completedFlow = useRef<string | null>(null);
  const callback = useRef(onAuthenticated);
  callback.current = onAuthenticated;
  const [operation, setOperation] = useState<{
    target: string;
    pending: boolean;
    error: string | null;
  }>({ target, pending: false, error: null });
  const auth =
    allowed && query.isSuccess && query.error === null && query.data?.instanceId === instanceId
      ? query.data
      : null;
  const currentAuth = useRef(auth);
  currentAuth.current = auth;
  const supported =
    auth?.methods?.some((method) => method.id === PI_OPENAI_USAGE_AUTH_METHOD) ?? false;
  const active =
    supported &&
    (auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying");
  const queryError =
    !allowed || query.error === null
      ? null
      : query.failure?._tag === "ProviderSetupError" && query.failure.instanceId === instanceId
        ? query.failure.detail === "This provider does not support sign-in in T3 Code." ||
          query.failure.detail === "This provider instance is no longer available."
          ? query.failure.detail
          : "Native usage sign-in setup failed on this runtime. Check its Pi installation and retry status."
        : query.failure?._tag === "EnvironmentAuthorizationError"
          ? "Reading native usage sign-in status requires providers:manage permission on this environment."
          : "Could not read native usage sign-in status.";
  const valid = (requestGeneration: number) =>
    requestGeneration === generation.current &&
    currentTarget.current === target &&
    permission.current &&
    readEnvironmentScope(environmentId, AuthProvidersManageScope);
  const cancelOwned = (flowId: string) => {
    if (readEnvironmentScope(environmentId, AuthProvidersManageScope))
      void cancelCommand({ environmentId, input: { instanceId, flowId } }).catch(() => {});
  };
  useLayoutEffect(() => {
    currentTarget.current = target;
    permission.current = allowed;
    inFlight.current = false;
    ownedFlow.current = null;
    observedFlow.current = null;
    completedFlow.current = null;
    setOperation({ target, pending: false, error: null });
    return () => {
      generation.current += 1;
      permission.current = false;
      currentTarget.current = "";
      if (ownedFlow.current) cancelOwned(ownedFlow.current);
      ownedFlow.current = null;
    };
  }, [target, allowed, cancelCommand]);
  useEffect(() => {
    if (!auth || !supported || !auth.flowId) return;
    if (ownedFlow.current === auth.flowId)
      setOperation((previous) =>
        previous.target === target && previous.pending
          ? { target, pending: false, error: null }
          : previous,
      );
    if (active) observedFlow.current = auth.flowId;
    if (
      auth.phase === "succeeded" &&
      (ownedFlow.current === auth.flowId || observedFlow.current === auth.flowId) &&
      completedFlow.current !== auth.flowId &&
      permission.current &&
      currentTarget.current === target &&
      readEnvironmentScope(environmentId, AuthProvidersManageScope)
    ) {
      completedFlow.current = auth.flowId;
      ownedFlow.current = null;
      callback.current();
    } else if (
      (auth.phase === "failed" || auth.phase === "cancelled") &&
      ownedFlow.current === auth.flowId
    )
      ownedFlow.current = null;
  }, [auth, active, supported, target, operation]);
  async function start() {
    const latestAuth = currentAuth.current;
    if (
      !allowed ||
      !latestAuth ||
      latestAuth.instanceId !== instanceId ||
      !latestAuth.methods?.some((method) => method.id === PI_OPENAI_USAGE_AUTH_METHOD) ||
      latestAuth.phase === "starting" ||
      latestAuth.phase === "waiting" ||
      latestAuth.phase === "verifying" ||
      ownedFlow.current ||
      inFlight.current ||
      currentTarget.current !== target ||
      !permission.current ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope)
    ) {
      if (currentTarget.current === target && !inFlight.current && !ownedFlow.current && !active)
        setOperation({
          target,
          pending: false,
          error:
            "Could not start native OpenAI usage sign-in. Check status and permissions, then try again.",
        });
      return;
    }
    inFlight.current = true;
    const requestGeneration = ++generation.current;
    setOperation({ target, pending: true, error: null });
    try {
      const response = await startCommand({
        environmentId,
        input: { instanceId, methodId: PI_OPENAI_USAGE_AUTH_METHOD },
      });
      if (!valid(requestGeneration)) {
        if (
          response._tag === "Success" &&
          response.value.instanceId === instanceId &&
          response.value.flowId
        )
          cancelOwned(response.value.flowId);
        return;
      }
      if (
        response._tag !== "Success" ||
        response.value.instanceId !== instanceId ||
        !response.value.flowId
      )
        throw new Error("start failed");
      ownedFlow.current = response.value.flowId;
      observedFlow.current = response.value.flowId;
      setOperation({ target, pending: true, error: null });
      query.refresh();
    } catch {
      if (valid(requestGeneration))
        setOperation({
          target,
          pending: false,
          error: "Could not start native OpenAI usage sign-in. Try again.",
        });
    } finally {
      if (requestGeneration === generation.current) inFlight.current = false;
    }
  }
  async function cancel() {
    if (
      !allowed ||
      !cancelAllowed ||
      !auth?.flowId ||
      !active ||
      inFlight.current ||
      !permission.current ||
      currentTarget.current !== target ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope)
    )
      return;
    inFlight.current = true;
    const requestGeneration = ++generation.current;
    setOperation({ target, pending: true, error: null });
    try {
      const response = await cancelCommand({
        environmentId,
        input: { instanceId, flowId: auth.flowId },
      });
      if (!valid(requestGeneration)) return;
      if (
        response._tag !== "Success" ||
        response.value.instanceId !== instanceId ||
        response.value.flowId !== auth.flowId ||
        response.value.phase !== "cancelled"
      )
        throw new Error("cancel failed");
      ownedFlow.current = null;
      setOperation({ target, pending: false, error: null });
      query.refresh();
    } catch {
      if (valid(requestGeneration))
        setOperation({
          target,
          pending: false,
          error: "Could not cancel native usage sign-in. Try again.",
        });
    } finally {
      if (requestGeneration === generation.current) inFlight.current = false;
    }
  }
  async function openBrowser() {
    const interaction = auth?.interaction;
    if (
      !allowed ||
      !active ||
      inFlight.current ||
      !auth?.flowId ||
      !interaction ||
      (interaction.type !== "deviceCode" && interaction.type !== "browser") ||
      !permission.current ||
      currentTarget.current !== target ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope)
    )
      return;
    const requestGeneration = generation.current;
    try {
      const url = new URL(interaction.url);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "auth.openai.com" ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error("invalid url");
      if (interaction.type === "browser" && interaction.requiresConsent) {
        if (!respondAllowed) return;
        const response = await respondCommand({
          environmentId,
          input: {
            instanceId,
            flowId: auth.flowId,
            interactionId: interaction.id,
            response: { type: "browser", action: "accept" },
          },
        });
        if (response._tag !== "Success" || !valid(requestGeneration)) return;
      }
      if (
        valid(requestGeneration) &&
        currentAuth.current?.flowId === auth.flowId &&
        currentAuth.current.interaction?.id === interaction.id
      )
        await ensureLocalApi().shell.openExternal(url.href);
    } catch {
      if (valid(requestGeneration))
        setOperation({
          target,
          pending: false,
          error: "Could not open the native OpenAI sign-in page. Try again.",
        });
    }
  }
  return {
    allowed,
    supported,
    auth,
    active,
    loading: query.isPending && !auth,
    error: operation.target === target ? operation.error : null,
    pending: operation.target === target && operation.pending,
    queryFailed: queryError !== null,
    queryError,
    canCancel: cancelAllowed,
    start,
    cancel,
    openBrowser,
    refresh: () => {
      if (
        allowed &&
        permission.current &&
        currentTarget.current === target &&
        readEnvironmentScope(environmentId, AuthProvidersManageScope)
      )
        query.refresh();
    },
  };
}
