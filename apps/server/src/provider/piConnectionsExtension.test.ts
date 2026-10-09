import { describe, expect, it, vi } from "vite-plus/test";
import {
  PI_CONNECTIONS_COMMAND,
  PI_CONNECTIONS_EXTENSION_SOURCE,
} from "./piConnectionsExtension.ts";

describe("Pi native discovery extension", () => {
  it("enumerates native and custom services without resolving or exposing credentials", async () => {
    const factory = new Function(
      PI_CONNECTIONS_EXTENSION_SOURCE.replace("export default", "return"),
    )();
    const commands = new Map<string, { description: string }>();
    const events = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
    factory({
      on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) =>
        events.set(name, handler),
      registerCommand: (name: string, command: { description: string }) =>
        commands.set(name, command),
    });
    const getApiKeyAndHeaders = vi.fn(() => {
      throw new Error("credential access is forbidden");
    });
    const models = [
      { provider: "anthropic", id: "claude", name: "Claude", apiKey: "NEVER_EXPORT_KEY" },
      {
        provider: "custom",
        id: "local",
        name: "Local",
        headers: { authorization: "NEVER_EXPORT_HEADER" },
      },
    ];
    await events.get("session_start")!(undefined, {
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => [models[0]],
        getProvider: (service: string) => ({
          name: service,
          auth: { apiKey: {}, ...(service === "anthropic" ? { oauth: {} } : {}) },
          credentials: "NEVER_EXPORT_CREDENTIALS",
        }),
        getProviderAuthStatus: (service: string) => ({
          configured: service === "anthropic",
          source: "stored",
          label: "NEVER_EXPORT_LABEL",
        }),
        getApiKeyAndHeaders,
      },
    });
    const description = commands.get(PI_CONNECTIONS_COMMAND)!.description;
    expect(description).not.toContain("NEVER_EXPORT");
    expect(JSON.parse(description)).toMatchObject([
      {
        service: "anthropic",
        configured: true,
        authMethods: ["api_key", "oauth"],
        limits: "unavailable",
        models: [{ slug: "anthropic/claude", available: true }],
      },
      {
        service: "custom",
        configured: false,
        authMethods: ["api_key"],
        models: [{ slug: "custom/local", available: false }],
      },
    ]);
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
  });
});
