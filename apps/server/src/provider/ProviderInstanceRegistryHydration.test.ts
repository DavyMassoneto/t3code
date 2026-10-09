import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../orchestration-v2/builtInProviderAdapterDrivers.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import type { ProviderDriver, ProviderInstance } from "./ProviderDriver.ts";
import {
  makeProviderInstanceRegistry,
  ProviderInstanceRegistry,
} from "./ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const pi = ProviderDriverKind.make("pi");

const layerPiInfrastructure = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pi-only-registry-test-" })),
  Layer.provideMerge(Settings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected network access")),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("Pi-only provider hydration", () => {
  it("hydrates only Pi on a fresh environment", () => {
    const settings = decodeSettings({});
    expect(deriveProviderInstanceConfigMap(settings)).toEqual({
      pi: { driver: "pi", config: settings.providers.pi },
    });
    expect([...BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2]).toEqual(["pi"]);
  });

  it("retains explicit legacy and unknown envelopes without changing user settings", () => {
    const settings = decodeSettings({
      providers: { codex: { enabled: true }, pi: { enabled: false } },
      providerInstances: {
        pi: { driver: "pi", enabled: false, config: { binaryPath: "custom-pi" } },
        legacy: { driver: "codex", config: { homePath: "custom-home", opaque: true } },
        fork: { driver: "unknown-fork", config: { untouched: [1, 2] } },
      },
    });
    const before = structuredClone(settings);
    expect(deriveProviderInstanceConfigMap(settings)).toEqual(settings.providerInstances);
    expect(settings).toEqual(before);
  });

  it.effect(
    "materializes the real Pi driver with its adapter and snapshot without other harness infrastructure",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("custom-pi");
        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: BUILT_IN_DRIVERS,
          configMap: { [instanceId]: { driver: pi, enabled: false, config: {} } },
        });
        const instance = yield* registry.getInstance(instanceId);
        expect(instance).toBeDefined();
        expect(instance?.driverKind).toBe(pi);
        expect(instance?.orchestrationAdapter.instanceId).toBe(instanceId);
        expect(instance?.textGeneration).toBeDefined();
        const snapshot = yield* instance!.snapshot.getSnapshot;
        expect(snapshot.instanceId).toBe(instanceId);
        expect(snapshot.driver).toBe(pi);
        expect(snapshot.enabled).toBe(false);
        expect(yield* registry.listUnavailable).toEqual([]);
      }).pipe(Effect.provide(layerPiInfrastructure)),
  );

  it.effect("instantiates and selects only Pi, including custom IDs and hot reload", () =>
    Effect.gen(function* () {
      const created: ProviderInstanceId[] = [];
      const drivers: ReadonlyArray<ProviderDriver<PiSettings>> = BUILT_IN_DRIVERS.map((driver) => ({
        ...driver,
        configSchema: PiSettings,
        create: ({ instanceId, enabled }) =>
          Effect.sync(() => {
            created.push(instanceId);
            return {
              instanceId,
              driverKind: driver.driverKind,
              displayName: undefined,
              enabled,
              continuationIdentity: {
                driverKind: driver.driverKind,
                continuationKey: `pi:${instanceId}`,
              },
              orchestrationAdapter: {
                instanceId,
                driver: driver.driverKind,
                getCapabilities: () => Effect.die("Unused capabilities"),
                planSelectionTransition: () =>
                  Effect.succeed({ type: "apply_on_next_turn" as const }),
                openSession: () => Effect.die("Unused session"),
              },
              get snapshot(): never {
                throw new Error("Unused snapshot");
              },
              get textGeneration(): never {
                throw new Error("Unused text generation");
              },
            } satisfies ProviderInstance;
          }),
      }));
      const customPiId = ProviderInstanceId.make("work-pi");
      const legacyDrivers = [
        "codex",
        "claudeAgent",
        "cursor",
        "grok",
        "opencode",
        "antigravity",
        "muse",
        "acpRegistry",
        "unknown-fork",
      ];
      const configMap: ProviderInstanceConfigMap = {
        [customPiId]: { driver: pi, config: {} },
        ...Object.fromEntries(
          legacyDrivers.map((driver) => [
            driver,
            { driver: ProviderDriverKind.make(driver), enabled: true, config: { preserved: true } },
          ]),
        ),
      };
      const original = structuredClone(configMap);
      const { registry, mutator } = yield* makeProviderInstanceRegistry({ drivers, configMap });
      const adapters = yield* Effect.service(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ).pipe(
        Effect.provide(
          ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
            Layer.provide(Layer.succeed(ProviderInstanceRegistry, registry)),
          ),
        ),
      );
      expect(created).toEqual([customPiId]);
      expect(yield* adapters.list()).toEqual([customPiId]);
      expect((yield* adapters.get(customPiId)).driver).toBe(pi);
      expect((yield* registry.listUnavailable).map((snapshot) => snapshot.driver)).toEqual(
        legacyDrivers,
      );
      for (const driver of legacyDrivers) {
        expect(yield* registry.getInstance(ProviderInstanceId.make(driver))).toBeUndefined();
        const error = yield* adapters.get(ProviderInstanceId.make(driver)).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProviderAdapterRegistry.ProviderAdapterRegistryLookupError);
      }
      yield* mutator.reconcile(configMap);
      expect(created).toEqual([customPiId]);
      yield* mutator.reconcile({
        ...configMap,
        [customPiId]: { driver: ProviderDriverKind.make("codex"), config: {} },
      });
      expect(yield* adapters.list()).toEqual([]);
      yield* mutator.reconcile(configMap);
      expect(created).toEqual([customPiId, customPiId]);
      expect(yield* adapters.list()).toEqual([customPiId]);
      expect(configMap).toEqual(original);
    }).pipe(Effect.scoped),
  );
});
