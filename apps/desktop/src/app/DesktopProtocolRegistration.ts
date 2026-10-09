import type * as Electron from "electron";

export function withDesktopProtocolRegistration<Result>(
  app: Pick<Electron.App, "setAsDefaultProtocolClient">,
  suppressed: boolean,
  createBridge: () => Result,
): Result {
  if (!suppressed) return createBridge();

  const register = app.setAsDefaultProtocolClient;
  app.setAsDefaultProtocolClient = () => false;
  try {
    return createBridge();
  } finally {
    app.setAsDefaultProtocolClient = register;
  }
}
