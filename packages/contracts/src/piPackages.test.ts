import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  PiPackageMutationInput,
  PiPackageSource,
  PiPackageSearchInput,
  PiPackageSearchResult,
} from "./piPackages.ts";

const isSearchInput = Schema.is(PiPackageSearchInput);
const isSearchResult = Schema.is(PiPackageSearchResult);

describe("Pi package contracts", () => {
  it("accepts optional positive bounded integer pages without breaking older search inputs", () => {
    expect(isSearchInput({ query: "" })).toBe(true);
    for (const page of [1, 2, 109, 1000000]) expect(isSearchInput({ query: "", page })).toBe(true);
    for (const page of [0, -1, 1.5, NaN, Infinity, 1000001, "2"])
      expect(isSearchInput({ query: "", page })).toBe(false);
  });

  it("validates genuine optional gallery metadata and preserves zero downloads", () => {
    const base = {
      catalogUrl: "https://pi.dev/packages",
      packages: [
        {
          name: "fixture",
          source: "npm:fixture",
          description: "Fixture",
          url: "https://pi.dev/packages/fixture",
          types: ["extension"],
        },
      ],
    };
    expect(isSearchResult(base)).toBe(true);
    const metadata = {
      author: "fixture-author",
      monthlyDownloads: 0,
      publishedAt: "2026-10-06T00:00:00.000Z",
    };
    expect(
      isSearchResult({
        ...base,
        packages: [{ ...base.packages[0], ...metadata }],
        pagination: {
          page: 1,
          totalPages: 109,
          total: 5444,
          catalogTotal: 5444,
          rangeStart: 1,
          rangeEnd: 50,
          hasNext: true,
          hasPrevious: false,
        },
      }),
    ).toBe(true);
    for (const monthlyDownloads of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        isSearchResult({
          ...base,
          packages: [{ ...base.packages[0], monthlyDownloads }],
        }),
      ).toBe(false);
    for (const publishedAt of [
      "not-a-date",
      "2026-02-30T00:00:00.000Z",
      "2026-10-06",
      "2026-10-06T00:00:00.000Zsecret",
    ])
      expect(
        isSearchResult({
          ...base,
          packages: [{ ...base.packages[0], publishedAt }],
        }),
      ).toBe(false);
    for (const author of ["", " ", "a".repeat(257), "native\u0000author"])
      expect(isSearchResult({ ...base, packages: [{ ...base.packages[0], author }] })).toBe(false);
    expect(
      isSearchResult({
        ...base,
        pagination: { page: 0, totalPages: 109, total: 5444, hasNext: true, hasPrevious: false },
      }),
    ).toBe(false);
  });
  it("requires explicit code execution consent", () => {
    const input = {
      instanceId: "pi",
      scope: "global",
      source: "npm:test-fixture",
      action: "install",
    };
    expect(Schema.is(PiPackageMutationInput)(input)).toBe(false);
    expect(Schema.is(PiPackageMutationInput)({ ...input, consent: false })).toBe(false);
    expect(Schema.is(PiPackageMutationInput)({ ...input, consent: true })).toBe(true);
  });

  it("rejects option-like, blank, and control-character sources", () => {
    for (const source of [
      "--all",
      "--self",
      "-l",
      "npm:--global",
      "npm:--cache=unsafe",
      "git:--upload-pack=bad",
      "npm:",
      "git:",
      "",
      " npm:test",
      "npm:test\n--all",
      "npm:test\u0000",
    ]) {
      expect(Schema.is(PiPackageSource)(source)).toBe(false);
    }
    for (const source of [
      "npm:@scope/package@1.0.0",
      "git:github.com/owner/repo@v1",
      "./local package",
    ]) {
      expect(Schema.is(PiPackageSource)(source)).toBe(true);
    }
  });
});
