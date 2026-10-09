import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveNativePiAgentDirectory } from "./nativePiAgentDirectory.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("native Pi agent directory", () => {
  it.effect("uses the Unix child HOME for defaults and tilde overrides", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolve = (environment: NodeJS.ProcessEnv) =>
        resolveNativePiAgentDirectory({
          environment,
          platform: "linux",
          fallbackHome: "/host-home",
          path,
        });
      expect(resolve({ HOME: "/instance-home" })).toBe("/instance-home/.pi/agent");
      expect(resolve({ HOME: "/instance-home", PI_CODING_AGENT_DIR: "~/custom-agent" })).toBe(
        "/instance-home/custom-agent",
      );
      expect(resolve({ HOME: "/instance-home", PI_CODING_AGENT_DIR: "~" })).toBe("/instance-home");
      const home = { name: "HOME", value: "/instance-home", sensitive: false };
      const pi = { name: "PI_CODING_AGENT_DIR", value: "~/custom-agent", sensitive: false };
      for (const variables of [
        [home, pi],
        [pi, home],
      ]) {
        expect(resolve(mergeProviderInstanceEnvironment(variables, { HOME: "/parent-home" }))).toBe(
          "/instance-home/custom-agent",
        );
      }
      expect(resolve({ HOME: "/instance-home", PI_CODING_AGENT_DIR: "" })).toBe(
        "/instance-home/.pi/agent",
      );
      expect(resolve({ USERPROFILE: "/ignored-windows-home" })).toBe("/host-home/.pi/agent");
      expect(resolve({ HOME: "relative-home", PI_CODING_AGENT_DIR: "/explicit-agent" })).toBe(
        "/explicit-agent",
      );
      expect(() => resolve({ HOME: "relative-home" })).toThrow("ambiguous");
      expect(() =>
        resolve({ HOME: "/instance-home", PI_CODING_AGENT_DIR: "relative-agent" }),
      ).toThrow("ambiguous");
      expect(() =>
        resolve({ HOME: "/instance-home", PI_CODING_AGENT_DIR: "~\\custom-agent" }),
      ).toThrow("ambiguous");
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );

  it.effect("uses the Windows child USERPROFILE for defaults and both tilde separators", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolve = (environment: NodeJS.ProcessEnv) =>
        resolveNativePiAgentDirectory({
          environment,
          platform: "win32",
          fallbackHome: "C:\\HostHome",
          path,
        });
      expect(resolve({ USERPROFILE: "D:\\InstanceHome" })).toBe("D:\\InstanceHome\\.pi\\agent");
      const home = { name: "USERPROFILE", value: "D:\\InstanceHome", sensitive: false };
      const pi = { name: "PI_CODING_AGENT_DIR", value: "~/custom-agent", sensitive: false };
      for (const variables of [
        [home, pi],
        [pi, home],
      ]) {
        expect(
          resolve(mergeProviderInstanceEnvironment(variables, { USERPROFILE: "C:\\ParentHome" })),
        ).toBe("D:\\InstanceHome\\custom-agent");
      }
      expect(
        resolve({ USERPROFILE: "D:\\InstanceHome", PI_CODING_AGENT_DIR: "~/custom-agent" }),
      ).toBe("D:\\InstanceHome\\custom-agent");
      expect(
        resolve({ USERPROFILE: "D:\\InstanceHome", PI_CODING_AGENT_DIR: "~\\custom-agent" }),
      ).toBe("D:\\InstanceHome\\custom-agent");
      expect(resolve({ USERPROFILE: "D:\\InstanceHome", PI_CODING_AGENT_DIR: "~" })).toBe(
        "D:\\InstanceHome",
      );
      expect(
        resolve({ UserProfile: "D:\\CaseInsensitiveHome", pi_coding_agent_dir: "~/custom-agent" }),
      ).toBe("D:\\CaseInsensitiveHome\\custom-agent");
      expect(resolve({ HOME: "D:\\IgnoredUnixHome" })).toBe("C:\\HostHome\\.pi\\agent");
      expect(
        resolve({ USERPROFILE: "relative-home", PI_CODING_AGENT_DIR: "D:\\ExplicitAgent" }),
      ).toBe("D:\\ExplicitAgent");
      expect(() => resolve({ USERPROFILE: "relative-home" })).toThrow("ambiguous");
      expect(() =>
        resolve({ USERPROFILE: "D:\\InstanceHome", PI_CODING_AGENT_DIR: "relative-agent" }),
      ).toThrow("ambiguous");
    }).pipe(Effect.provide(NodePath.layerWin32)),
  );
});
