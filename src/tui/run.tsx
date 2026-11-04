import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { Globals } from "../cli";
import { App } from "./App";

// Exit code per signal (128 + signal number). SIGTERM keeps 130 like SIGINT.
const exitSignals = {
  SIGINT: 130,
  SIGTERM: 130,
  SIGHUP: 129,
  SIGQUIT: 131,
  SIGPIPE: 141,
} as const satisfies Partial<Record<NodeJS.Signals, number>>;

const deadTerminalErrors = new Set(["EIO", "EPIPE"]);

export async function runTui(options: Globals = {}): Promise<number> {
  // OpenTUI's own exit-signal handlers only destroy the renderer and never exit, so a closed
  // terminal (SIGHUP) left the process running with no TTY. The TUI handles the signals itself.
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      renderer.destroy();
      resolve(code);
    };

    for (const [signal, code] of Object.entries(exitSignals)) {
      process.once(signal, () => finish(code));
    }
    // The terminal is gone: stdin ends or a write to it fails.
    const hangUp = () => finish(exitSignals.SIGHUP);
    process.stdin.once("end", hangUp);
    process.stdin.once("close", hangUp);
    const onTerminalError = (error: NodeJS.ErrnoException) => {
      if (deadTerminalErrors.has(error.code ?? "")) hangUp();
    };
    process.stdin.on("error", onTerminalError);
    process.stdout.on("error", onTerminalError);

    createRoot(renderer).render(<App onQuit={finish} {...options} />);
  });
}
