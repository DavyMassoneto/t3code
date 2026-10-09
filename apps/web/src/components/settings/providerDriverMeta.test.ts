import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";

describe("Pi-only provider creation", () => {
  it("offers only Pi while retaining historical driver metadata", () => {
    expect(DRIVER_OPTIONS.map((option) => option.value)).toEqual(["pi"]);
    expect(getDriverOption(ProviderDriverKind.make("codex"))?.label).toBe("Codex");
    expect(getDriverOption(ProviderDriverKind.make("pi"))?.label).toBe("Pi");
  });
});
