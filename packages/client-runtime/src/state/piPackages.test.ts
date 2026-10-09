import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { AuthProvidersManageScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createPiPackageCommands } from "./piPackages.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const commands = createPiPackageCommands(runtime);

describe("Pi package client permissions", () => {
  it("advertises providers:manage and reflects the destination environment grant", () => {
    const registry = AtomRegistry.make();
    const allowed = EnvironmentId.make("packages-allowed");
    const denied = EnvironmentId.make("packages-denied");
    const grant = (
      permissions: NonNullable<AuthSessionState["permissions"]>,
    ): AuthSessionState => ({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: permissions,
      permissions,
    });
    try {
      registry.mount(sessions(allowed));
      registry.mount(sessions(denied));
      registry.set(sessions(allowed), AsyncResult.success(grant([AuthProvidersManageScope])));
      registry.set(sessions(denied), AsyncResult.success(grant([])));
      expect(commands.mutate.requiredScopes()).toEqual([AuthProvidersManageScope]);
      expect(registry.get(commands.mutate.permissionAtom(allowed))).toBe(true);
      expect(registry.get(commands.mutate.permissionAtom(denied))).toBe(false);
    } finally {
      registry.dispose();
    }
  });
});
