import { describe, expect, it, vi } from "vite-plus/test";
import type * as Electron from "electron";

import { withDesktopProtocolRegistration } from "./DesktopProtocolRegistration.ts";

describe("withDesktopProtocolRegistration", () => {
  it("preserves default registration", () => {
    const register = vi.fn(() => true);
    const app: Pick<Electron.App, "setAsDefaultProtocolClient"> = {
      setAsDefaultProtocolClient: register,
    };
    const result = withDesktopProtocolRegistration(app, false, () =>
      app.setAsDefaultProtocolClient("t3code"),
    );
    expect(result).toBe(true);
    expect(register).toHaveBeenCalledWith("t3code");
    expect(app.setAsDefaultProtocolClient).toBe(register);
  });

  it("suppresses synchronous SDK registration and immediately restores the method", () => {
    const register = vi.fn(() => true);
    const app: Pick<Electron.App, "setAsDefaultProtocolClient"> = {
      setAsDefaultProtocolClient: register,
    };
    const result = withDesktopProtocolRegistration(app, true, () =>
      app.setAsDefaultProtocolClient("t3code"),
    );
    expect(result).toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(app.setAsDefaultProtocolClient).toBe(register);
  });

  it("restores the method even when bridge initialization throws", () => {
    const register = vi.fn(() => true);
    const app: Pick<Electron.App, "setAsDefaultProtocolClient"> = {
      setAsDefaultProtocolClient: register,
    };
    const failure = new Error("bridge failed");
    expect(() =>
      withDesktopProtocolRegistration(app, true, () => {
        app.setAsDefaultProtocolClient("t3code");
        throw failure;
      }),
    ).toThrow(failure);
    expect(register).not.toHaveBeenCalled();
    expect(app.setAsDefaultProtocolClient).toBe(register);
  });
});
