import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

it.effect("denies key writes before invoking the handler", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverSetPiConnectionApiKey
        > => tag !== WS_METHODS.serverSetPiConnectionApiKey,
      ),
    );
    let called = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverSetPiConnectionApiKey, (input) =>
            Effect.sync(() => {
              called = true;
              return {
                instanceId: input.instanceId,
                service: input.service,
                configured: true as const,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    const denied = yield* client[WS_METHODS.serverSetPiConnectionApiKey]({
      instanceId: ProviderInstanceId.make("pi-work"),
      service: "anthropic",
      apiKey: Redacted.make("synthetic-only"),
      consent: true,
    }).pipe(Effect.flip);
    expect(denied).toMatchObject({ requiredPermission: AuthProvidersManageScope });
    expect(called).toBe(false);
  }).pipe(Effect.scoped),
);
