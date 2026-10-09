import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

describe("Pi package RPC authorization", () => {
  it("separates catalog and installed reads from code installation", () => {
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.serverSearchPiPackages)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.serverListPiPackages)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.serverMutatePiPackage)).toBe(
      AuthProvidersManageScope,
    );
  });

  it.effect("refuses denied mutations without calling the package handler", () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.serverMutatePiPackage
          > => tag !== WS_METHODS.serverMutatePiPackage,
        ),
      );
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverMutatePiPackage, () =>
              Effect.sync(() => {
                handled = true;
                return { packages: [], scopeLabel: "test" };
              }),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      const result = yield* client[WS_METHODS.serverMutatePiPackage]({
        instanceId: ProviderInstanceId.make("pi"),
        scope: "global",
        action: "install",
        source: "npm:test-fixture",
        consent: true,
      }).pipe(Effect.flip);
      expect(result).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});
