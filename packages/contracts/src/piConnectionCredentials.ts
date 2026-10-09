import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PiConnectionApiKey = Schema.RedactedFromValue(Schema.String).check(
  Schema.makeFilter(
    (value) => {
      const key = Redacted.value(value);
      return (
        key.length <= 8192 &&
        key.trim().length > 0 &&
        !key.trimStart().startsWith("!") &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(key)
      );
    },
    { expected: "a nonempty API key of at most 8192 characters without control characters" },
  ),
);
export const PiConnectionCredentialsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  service: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[^\s\u0000-\u001f\u007f-\u009f]+$/u),
    Schema.makeFilter((value) => !["__proto__", "constructor", "prototype"].includes(value), {
      expected: "a native service identifier",
    }),
  ),
  apiKey: PiConnectionApiKey,
  consent: Schema.Literal(true),
});
export type PiConnectionCredentialsInput = typeof PiConnectionCredentialsInput.Type;
export const PiConnectionCredentialsResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  service: Schema.String,
  configured: Schema.Literal(true),
});
export type PiConnectionCredentialsResult = typeof PiConnectionCredentialsResult.Type;
export class PiConnectionCredentialsError extends Schema.TaggedError<PiConnectionCredentialsError>()(
  "PiConnectionCredentialsError",
  { message: Schema.String },
) {}
