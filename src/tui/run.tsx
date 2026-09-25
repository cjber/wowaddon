import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { Globals } from "../cli";
import { App } from "./App";

export async function runTui(options: Globals = {}): Promise<number> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      renderer.destroy();
      resolve(code);
    };

    process.once("SIGINT", () => finish(130));
    process.once("SIGTERM", () => finish(130));

    createRoot(renderer).render(<App onQuit={finish} {...options} />);
  });
}
