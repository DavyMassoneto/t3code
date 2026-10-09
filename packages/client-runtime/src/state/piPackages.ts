import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createPiPackageCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    search: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pi-packages:search",
      tag: WS_METHODS.serverSearchPiPackages,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pi-packages:list",
      tag: WS_METHODS.serverListPiPackages,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pi-packages:mutate",
      tag: WS_METHODS.serverMutatePiPackage,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))([
            environmentId,
            input.instanceId,
            input.scope,
            input.projectId ?? null,
            input.action,
            input.source,
          ]),
      },
    }),
  };
}
