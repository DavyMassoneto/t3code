import { describe, expect, it } from "vite-plus/test";
import { isInteractiveProvider } from "./providerPolicy.js";

describe("Pi-only provider policy", () => {
  it("allows Pi without treating its instance id as its driver", () => {
    expect(isInteractiveProvider("pi")).toBe(true);
    expect(isInteractiveProvider("pi_work")).toBe(false);
  });

  it.each(["codex", "claudeAgent", "acpRegistry", "custom", undefined, null])(
    "does not expose %s as an interactive harness",
    (driver) => expect(isInteractiveProvider(driver)).toBe(false),
  );
});
