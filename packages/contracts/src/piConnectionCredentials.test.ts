import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  PiConnectionApiKey,
  PiConnectionCredentialsInput,
  PiConnectionCredentialsResult,
} from "./piConnectionCredentials.ts";
import { AuthProvidersManageScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("Pi API key credentials", () => {
  const decode = Schema.decodeUnknownSync(PiConnectionCredentialsInput);
  it("requires consent and round trips only the protected request", () => {
    const input = {
      instanceId: "pi",
      service: "anthropic",
      apiKey: "synthetic-key",
      consent: true,
    };
    const decoded = decode(input);
    expect(Redacted.value(decoded.apiKey)).toBe(input.apiKey);
    expect(JSON.stringify(decoded)).not.toContain(input.apiKey);
    expect(Schema.encodeSync(PiConnectionCredentialsInput)(decoded)).toEqual(input);
    for (const consent of [undefined, false]) expect(() => decode({ ...input, consent })).toThrow();
    expect(clientRpcRequiredScopes(WS_METHODS.serverSetPiConnectionApiKey, input)).toEqual([
      AuthProvidersManageScope,
    ]);
  });
  it("bounds keys without exposing invalid string contents", () => {
    const decodeKey = Schema.decodeUnknownSync(PiConnectionApiKey);
    for (const key of [
      "",
      " ",
      "!synthetic-secret",
      "  !synthetic-secret",
      "synthetic-secret\n",
      "synthetic-secret\u0000",
      "synthetic-secret\u007f",
      "x".repeat(8193),
    ]) {
      try {
        decodeKey(key);
        expect.fail("must reject invalid key");
      } catch (error) {
        expect(String(error)).not.toContain("synthetic-secret");
      }
    }
    expect(Redacted.value(decodeKey("x".repeat(8192)))).toHaveLength(8192);
    expect(Redacted.value(decodeKey("literal-$HOME"))).toBe("literal-$HOME");
    for (const service of ["__proto__", "constructor", "prototype"])
      expect(() =>
        decode({ instanceId: "pi", service, apiKey: "fixture", consent: true }),
      ).toThrow();
  });
  it("returns stored configuration rather than claiming verified authentication", () => {
    expect(
      Schema.is(PiConnectionCredentialsResult)({
        instanceId: "pi",
        service: "anthropic",
        configured: true,
      }),
    ).toBe(true);
    expect(
      Schema.is(PiConnectionCredentialsResult)({
        instanceId: "pi",
        service: "anthropic",
        configured: false,
      }),
    ).toBe(false);
  });
});
