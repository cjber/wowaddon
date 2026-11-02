/** Runs the compiled binary outside the checkout, with a scratch home, through what a new user or agent does first. */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

const source = process.argv[2];
if (!source) throw new Error("usage: bun scripts/smoke-binary.ts <binary>");
const scratch = mkdtempSync(join(tmpdir(), "wowaddon-binary-"));
const executable = join(scratch, "installed wowaddon");
const addons = join(scratch, "AddOns");
const { XDG_CONFIG_HOME: _config, XDG_STATE_HOME: _state, ...inherited } = Bun.env;
const env = { ...inherited, HOME: scratch };

function wowaddon(...args: string[]): string {
  const result = Bun.spawnSync([executable, ...args], {
    env,
    cwd: scratch,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`wowaddon ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
  return result.stdout.toString();
}

try {
  copyFileSync(resolve(source), executable);
  chmodSync(executable, 0o755);
  mkdirSync(addons);
  if (!wowaddon("--version").includes(packageJson.version))
    throw new Error("--version does not match package.json");
  if (!wowaddon("--help").includes("wowaddon sync")) throw new Error("--help failed");
  for (const flavor of ["era", "forever"]) {
    const rows = JSON.parse(wowaddon("--flavor", flavor, "--addons-dir", addons, "list", "--json"));
    if (!Array.isArray(rows) || rows.length)
      throw new Error(`list --json for ${flavor} is not an empty array`);
  }
  console.log("version, help and list --json for both flavors passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
