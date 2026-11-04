import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "index.tsx");
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

// Starts the TUI in a pseudo-terminal and resolves once it has drawn its footer.
async function startTui() {
  const home = await mkdtemp(join(tmpdir(), "wowaddon-tui-"));
  scratch.push(home);
  await mkdir(join(home, "AddOns"));
  let output = "";
  let drawn: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    drawn = resolve;
  });
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 30,
    data(_terminal, data) {
      output += new TextDecoder().decode(data);
      if (output.includes("quit")) drawn();
    },
  });
  const proc = Bun.spawn([process.execPath, entry, "--addons-dir", join(home, "AddOns")], {
    terminal,
    env: {
      PATH: process.env.PATH,
      TERM: "xterm-256color",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".state"),
      WOWADDON_NO_UPDATE_CHECK: "1",
    },
  });
  await ready;
  return { proc, terminal };
}

async function exitCodeWithin(proc: Bun.Subprocess, ms: number) {
  const code = await Promise.race([proc.exited, Bun.sleep(ms).then(() => "still running")]);
  if (code === "still running") proc.kill("SIGKILL");
  return code;
}

test("the TUI exits when its terminal closes", async () => {
  const { proc, terminal } = await startTui();
  terminal.close();
  expect(await exitCodeWithin(proc, 3000)).toBe(129);
}, 20_000);

test("the TUI exits on SIGHUP", async () => {
  const { proc, terminal } = await startTui();
  proc.kill("SIGHUP");
  expect(await exitCodeWithin(proc, 3000)).toBe(129);
  terminal.close();
}, 20_000);
