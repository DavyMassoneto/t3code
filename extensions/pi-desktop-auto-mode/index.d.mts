export interface PiDesktopAutoModeContext {
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
  readonly model?: unknown;
  readonly modelRegistry?: {
    readonly streamSimple: (
      model: unknown,
      context: {
        systemPrompt: string;
        messages: Array<{ role: "user"; content: string; timestamp: number }>;
        tools?: undefined;
      },
      options: { maxTokens: number; reasoning: "minimal"; signal: AbortSignal },
    ) => {
      result(): Promise<{
        stopReason: string;
        content: Array<{ type: string; text?: string }>;
      }>;
    };
  };
  readonly sessionManager: {
    getBranch(): Array<{
      type: string;
      message?: { role: string; content: string | Array<{ type: string; text?: string }> };
    }>;
  };
  readonly ui: {
    readonly confirm: (title: string, message: string) => Promise<boolean>;
    readonly notify: (message: string, severity: "info" | "warning") => void;
    readonly setStatus?: (key: string, text: string | undefined) => void;
  };
}

export interface PiDesktopAutoModeAPI {
  readonly getAllTools?: () => Array<{ name: string; sourceInfo?: unknown }>;
  readonly on: (
    event:
      | "session_start"
      | "session_shutdown"
      | "agent_start"
      | "before_agent_start"
      | "agent_end"
      | "tool_call",
    handler: (event: unknown, ctx: PiDesktopAutoModeContext) => unknown,
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
