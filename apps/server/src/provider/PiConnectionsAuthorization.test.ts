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
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

it.effect("denies native account discovery before invoking the handler", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverListPiConnections
        > => tag !== WS_METHODS.serverListPiConnections,
      ),
    );
    let called = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverListPiConnections, (input) =>
            Effect.sync(() => {
              called = true;
              return { instanceId: input.instanceId, connections: [] };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.serverListPiConnections]({
        instanceId: ProviderInstanceId.make("pi-work"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
    expect(called).toBe(false);
  }).pipe(Effect.scoped),
);
