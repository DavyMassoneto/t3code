import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PiPackageScope = Schema.Literals(["global", "project"]);
export const PiPackageTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  scope: PiPackageScope,
  projectId: Schema.optionalKey(ProjectId),
});
export type PiPackageTarget = typeof PiPackageTarget.Type;

export const PiPackageSource = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^(?!npm:(?:-|\s|$))(?!git:(?:-|\s|$))[^\s\-\u0000-\u001f][^\u0000-\u001f]*$/u),
);
export const PiPackageType = Schema.Literals(["extension", "skill", "theme", "prompt"]);
const CatalogPage = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000000 }));
const CatalogCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const PublishedAt = Schema.String.check(
  Schema.makeFilter((value) => {
    const date = DateTime.make(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Option.isSome(date) &&
      DateTime.formatIso(date.value) === value
    );
  }),
);
export const PiPackageSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)),
  type: Schema.optionalKey(PiPackageType),
  sort: Schema.optionalKey(Schema.Literals(["downloads", "recent", "name"])),
  page: Schema.optionalKey(CatalogPage),
});
export type PiPackageSearchInput = typeof PiPackageSearchInput.Type;
export const PiPackageSearchResult = Schema.Struct({
  catalogUrl: Schema.String,
  pagination: Schema.optionalKey(
    Schema.Struct({
      page: CatalogPage,
      totalPages: Schema.optionalKey(CatalogPage),
      total: CatalogCount,
      catalogTotal: CatalogCount,
      rangeStart: Schema.optionalKey(CatalogCount),
      rangeEnd: Schema.optionalKey(CatalogCount),
      hasNext: Schema.Boolean,
      hasPrevious: Schema.Boolean,
    }),
  ),
  packages: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      source: PiPackageSource,
      url: Schema.String,
      types: Schema.Array(PiPackageType),
      author: Schema.optionalKey(
        TrimmedNonEmptyString.check(
          Schema.isMaxLength(256),
          Schema.makeFilter((value) =>
            Array.from(value).every((character) => {
              const code = character.charCodeAt(0);
              return code >= 32 && (code < 127 || code > 159);
            }),
          ),
        ),
      ),
      monthlyDownloads: Schema.optionalKey(CatalogCount),
      publishedAt: Schema.optionalKey(PublishedAt),
    }),
  ),
});
export type PiPackageSearchResult = typeof PiPackageSearchResult.Type;

export const PiPackageListResult = Schema.Struct({
  scopeLabel: Schema.String,
  packages: Schema.Array(
    Schema.Struct({
      source: PiPackageSource,
      scope: PiPackageScope,
      filtered: Schema.Boolean,
      installedPath: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type PiPackageListResult = typeof PiPackageListResult.Type;

export const PiPackageMutationInput = Schema.Struct({
  ...PiPackageTarget.fields,
  action: Schema.Literals(["install", "remove", "update"]),
  source: PiPackageSource,
  consent: Schema.Literal(true),
});
export type PiPackageMutationInput = typeof PiPackageMutationInput.Type;

export class PiPackageError extends Schema.TaggedError<PiPackageError>()("PiPackageError", {
  message: Schema.String,
}) {}
