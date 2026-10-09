import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { PiProviderLimits } from "./piProviderLimits.ts";

export const PiConnection = Schema.Struct({
  service: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  configured: Schema.Boolean,
  authSource: Schema.optionalKey(
    Schema.Literals([
      "stored",
      "runtime",
      "environment",
      "fallback",
      "models_json_key",
      "models_json_command",
    ]),
  ),
  authMethods: Schema.Array(Schema.Literals(["api_key", "oauth"])),
  authentication: Schema.Literal("managed-in-pi"),
  limits: Schema.Literals(["unavailable", "available", "not_applicable", "unsupported", "error"]),
  limitsDetails: Schema.optionalKey(PiProviderLimits),
  models: Schema.Array(
    Schema.Struct({
      slug: TrimmedNonEmptyString,
      name: TrimmedNonEmptyString,
      available: Schema.Boolean,
    }),
  ),
});
export type PiConnection = typeof PiConnection.Type;
export const PiConnectionsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  includeLimits: Schema.optionalKey(Schema.Boolean),
});
export type PiConnectionsInput = typeof PiConnectionsInput.Type;
export const PiConnectionsResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  connections: Schema.Array(PiConnection),
});
export type PiConnectionsResult = typeof PiConnectionsResult.Type;
export class PiConnectionsError extends Schema.TaggedError<PiConnectionsError>()(
  "PiConnectionsError",
  { message: Schema.String },
) {}
