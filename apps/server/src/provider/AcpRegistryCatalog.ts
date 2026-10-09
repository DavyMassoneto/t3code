import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AcpRegistrySupport from "./acp/AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./acp/AcpRegistryRuntimeCoordinator.ts";

const unavailable = () =>
  Effect.fail(
    new AcpRegistrySupport.AcpRegistryError({
      reason: "registry_unavailable",
      detail: "ACP harnesses are not available in this Pi-only build.",
    }),
  );

export const layer = Layer.merge(
  Layer.succeed(AcpRegistrySupport.AcpRegistryCatalog, {
    search: unavailable,
    prepare: unavailable,
    inspect: unavailable,
    resolve: unavailable,
    uninstallManagedBinary: unavailable,
  }),
  AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator.layer,
);
