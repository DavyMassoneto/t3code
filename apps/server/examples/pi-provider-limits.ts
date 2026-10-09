type LimitsRequest = {
  version: number;
  register: (
    service: string,
    reader: (request: { signal: AbortSignal }) => Promise<unknown>,
  ) => void;
};

const fixtureConfig = {
  name: "Synthetic limits protocol fixture",
  api: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "synthetic-fixture-not-an-account",
  models: [
    {
      id: "fixture",
      name: "Synthetic fixture",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    },
  ],
};

type FixtureExtensionAPI = {
  registerProvider: (service: string, config: typeof fixtureConfig) => void;
  events: { on: (channel: string, handler: (data: unknown) => void) => unknown };
};

export default function fixtureProviderLimits(pi: FixtureExtensionAPI) {
  pi.registerProvider("t3-limits-fixture", fixtureConfig);
  pi.events.on("t3:provider-limits:collect", (data) => {
    const request = data as LimitsRequest;
    if (request.version !== 1 || typeof request.register !== "function") return;
    request.register("t3-limits-fixture", async ({ signal }) => {
      signal.throwIfAborted();
      return { metrics: [{ unit: "credits", remaining: 7.5 }] };
    });
  });
}
