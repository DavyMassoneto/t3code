import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const FiniteNumber = Schema.Number.check(Schema.isFinite());
const IsoTimestamp = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Option.isSome(parsed) &&
      DateTime.formatIso(parsed.value) === value
    );
  }),
);

export const PiProviderLimitMetric = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  unit: TrimmedNonEmptyString,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  used: Schema.optionalKey(FiniteNumber),
  limit: Schema.optionalKey(FiniteNumber),
  remaining: Schema.optionalKey(FiniteNumber),
  windowSeconds: Schema.optionalKey(FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0))),
  resetsAt: Schema.optionalKey(IsoTimestamp),
});
export type PiProviderLimitMetric = typeof PiProviderLimitMetric.Type;

export const PiProviderLimits = Schema.Struct({
  status: Schema.Literals(["available", "not_applicable", "unsupported", "error"]),
  checkedAt: IsoTimestamp,
  source: TrimmedNonEmptyString,
  message: Schema.optionalKey(TrimmedNonEmptyString),
  metrics: Schema.Array(PiProviderLimitMetric),
});
export type PiProviderLimits = typeof PiProviderLimits.Type;
