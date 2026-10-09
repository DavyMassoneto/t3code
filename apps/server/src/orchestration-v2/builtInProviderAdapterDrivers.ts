import type { ProviderDriverKind } from "@t3tools/contracts";

import { PiAdapterV2Driver, type PiAdapterV2DriverEnv } from "./Adapters/PiAdapterV2.ts";
import type { AnyProviderAdapterDriver } from "./ProviderAdapterDriver.ts";

export type BuiltInProviderAdapterDriversV2Env = PiAdapterV2DriverEnv;

const BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2: ReadonlyArray<
  AnyProviderAdapterDriver<BuiltInProviderAdapterDriversV2Env>
> = [PiAdapterV2Driver];

export const BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2: ReadonlySet<ProviderDriverKind> = new Set(
  BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2.map((driver) => driver.driverKind),
);
