import { describe, expect, it } from "@effect/vitest";
import { AcpRegistrySettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AcpRegistryCatalog from "./AcpRegistryCatalog.ts";
import * as AcpRegistrySupport from "./acp/AcpRegistrySupport.ts";

const settings = Schema.decodeSync(AcpRegistrySettings)({});

describe("Pi-only ACP catalog", () => {
  it.effect("rejects discovery, installation and runtime resolution without host services", () =>
    Effect.gen(function* () {
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const operations: ReadonlyArray<Effect.Effect<unknown, AcpRegistrySupport.AcpRegistryError>> =
        [
          catalog.search({ query: "agent" }),
          catalog.prepare({ agentId: "agent" }),
          catalog.inspect(settings),
          catalog.resolve(settings, "/workspace"),
          catalog.uninstallManagedBinary({ agentId: "agent" }),
        ];
      for (const operation of operations) {
        const outcome = yield* operation.pipe(Effect.result);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") {
          expect(outcome.failure.reason).toBe("registry_unavailable");
          expect(outcome.failure.message).toContain("Pi-only");
        }
      }
    }).pipe(Effect.provide(AcpRegistryCatalog.layer)),
  );
});
