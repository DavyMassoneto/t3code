export interface PiDesktopAutoModeContext {
  readonly ui: {
    readonly confirm: (title: string, message: string) => Promise<boolean>;
    readonly notify: (message: string, severity: "info" | "warning") => void;
    readonly setStatus?: (key: string, text: string | undefined) => void;
  };
}

export interface PiDesktopAutoModeAPI {
  readonly on: (
    event: "session_start",
    handler: (event: unknown, ctx: PiDesktopAutoModeContext) => void,
  ) => void;
  readonly registerCommand: (
    name: string,
    command: {
      readonly description: string;
      readonly handler: (args: string, ctx: PiDesktopAutoModeContext) => Promise<void>;
    },
  ) => void;
}

export default function piDesktopAutoMode(pi: PiDesktopAutoModeAPI): void;
