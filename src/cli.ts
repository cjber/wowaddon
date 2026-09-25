import { addAddon, listRows, openContext, removeAddon, syncAddons } from "./service";
import type { Flavor, Progress, Row } from "./types";

const VERSION = "1.0.0";

const HELP = `wowaddon — manage WoW addons from GitHub, CurseForge and WoWInterface

Usage:
  wowaddon                               TUI if the terminal supports it, else sync
  wowaddon sync [<id|ref>...] [--adopt]
  wowaddon add <ref|url> [--note TEXT] [--no-install] [--adopt]
  wowaddon add <kind> <ref> [--note TEXT] [--no-install] [--adopt]
  wowaddon remove <id|ref>
  wowaddon list [--refresh] [--json]

Global options:
  --flavor era|forever   Client flavor (default: config, then era)
  --addons-dir PATH      AddOns folder to manage
  -h, --help             Show this help
  -V, --version          Show the version
`;

function usageError(message: string): never {
  throw new CliUsageError(message);
}

class CliUsageError extends Error {}

export interface Globals {
  flavor?: Flavor;
  addonsDir?: string;
}

interface ParsedArgs {
  globals: Globals;
  command?: string;
  rest: string[];
  help: boolean;
  version: boolean;
}

function isFlavor(value: string): value is Flavor {
  return value === "era" || value === "forever";
}

function parseArgs(argv: string[]): ParsedArgs {
  const globals: Globals = {};
  const rest: string[] = [];
  let command: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "-V" || arg === "--version") {
      version = true;
      continue;
    }
    if (arg === "--flavor" || arg.startsWith("--flavor=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!value || !isFlavor(value))
        usageError(`--flavor must be era or forever, got: ${value ?? ""}`);
      globals.flavor = value;
      continue;
    }
    if (arg === "--addons-dir" || arg.startsWith("--addons-dir=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!value) usageError("--addons-dir requires a path");
      globals.addonsDir = value;
      continue;
    }
    if (command === undefined && !arg.startsWith("-")) {
      command = arg;
      continue;
    }
    rest.push(arg);
  }

  return { globals, command, rest, help, version };
}

function formatResultLine(row: Row): string {
  const name = row.entry.note ?? row.entry.ref;
  if (row.status === "error") return `FAIL ${row.entry.id} ${row.message ?? name}`;
  if (row.status === "dev" || row.status === "unmanaged")
    return `SKIP ${row.entry.id} ${row.message ?? name}`;
  const version = row.installed?.version;
  return `OK   ${row.entry.id} ${name}${version ? ` ${version}` : ""}`;
}

function formatListLine(row: Row): string {
  const name = row.entry.note ?? row.entry.ref;
  const installedVersion = row.installed?.version;
  const latestVersion = row.latest?.version;
  const parts = [row.status.toUpperCase().padEnd(9), row.entry.id, name];
  if (installedVersion) parts.push(installedVersion);
  if (latestVersion && latestVersion !== installedVersion) parts.push(`-> ${latestVersion}`);
  if (row.message) parts.push(`(${row.message})`);
  return parts.join(" ");
}

// Bun colours console.error red, which makes every notice read as a failure.
function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

// One live status line on a terminal; the final OK/SKIP/FAIL line on stdout says how it ended.
function logProgress(progress: Progress): void {
  if (!process.stderr.isTTY) return;
  const ended = ["done", "skipped", "failed"].includes(progress.phase);
  process.stderr.write(ended ? "\r\x1b[2K" : `\r\x1b[2K${progress.id} ${progress.phase}…`);
}

function summarizeExit(rows: Row[]): number {
  return rows.some((row) => row.status === "error") ? 1 : 0;
}

function splitFlags(
  args: string[],
  booleanFlags: string[],
  valueFlags: string[],
): { flags: Record<string, string | boolean>; positionals: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (booleanFlags.includes(name)) {
        flags[name] = true;
        continue;
      }
      if (valueFlags.includes(name)) {
        const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined) usageError(`--${name} requires a value`);
        flags[name] = value;
        continue;
      }
      usageError(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

// The TUI opens with the same --flavor / --addons-dir the command line was given.
export function tuiOptions(argv: string[]): Globals {
  return parseArgs(argv).globals;
}

export async function runCli(argv: string[]): Promise<number | undefined> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  if (parsed.version) {
    console.log(`wowaddon ${VERSION}`);
    return 0;
  }

  const command =
    parsed.command ?? (process.stdin.isTTY && process.stdout.isTTY ? undefined : "sync");
  if (command === undefined) return undefined;

  const validCommands = ["sync", "add", "remove", "list"];
  if (!validCommands.includes(command)) {
    warn(`unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  const abortController = new AbortController();
  const onSigint = () => abortController.abort();
  process.once("SIGINT", onSigint);

  let ctx: Awaited<ReturnType<typeof openContext>>;
  try {
    ctx = await openContext({
      flavor: parsed.globals.flavor,
      addonsDir: parsed.globals.addonsDir,
      env: process.env,
    });
  } catch (error) {
    process.removeListener("SIGINT", onSigint);
    if (abortController.signal.aborted) return 130;
    warn(error instanceof Error ? error.message : String(error));
    return 2;
  }
  for (const notice of ctx.notices) warn(notice);

  try {
    if (command === "sync") {
      const { flags, positionals } = splitFlags(parsed.rest, ["adopt"], []);
      const rows = await syncAddons(ctx, {
        ids: positionals.length ? positionals : undefined,
        adopt: Boolean(flags.adopt),
        signal: abortController.signal,
        onProgress: logProgress,
      });
      for (const row of rows) console.log(formatResultLine(row));
      return summarizeExit(rows);
    }

    if (command === "add") {
      const { flags, positionals } = splitFlags(parsed.rest, ["no-install", "adopt"], ["note"]);
      if (!positionals.length) usageError("usage: wowaddon add <ref|url> | add <kind> <ref>");
      const input = positionals.join(" ");
      const row = await addAddon(ctx, input, {
        note: typeof flags.note === "string" ? flags.note : undefined,
        install: !flags["no-install"],
        adopt: Boolean(flags.adopt),
        signal: abortController.signal,
        onProgress: logProgress,
      });
      console.log(formatResultLine(row));
      return summarizeExit([row]);
    }

    if (command === "remove") {
      const { positionals } = splitFlags(parsed.rest, [], []);
      if (!positionals.length) usageError("usage: wowaddon remove <id|ref>");
      await removeAddon(ctx, positionals.join(" "));
      console.log(`OK   removed ${positionals.join(" ")}`);
      return 0;
    }

    if (command === "list") {
      const { flags, positionals } = splitFlags(parsed.rest, ["refresh", "json"], []);
      if (positionals.length) usageError("usage: wowaddon list [--refresh] [--json]");
      const rows = await listRows(ctx, {
        refresh: Boolean(flags.refresh),
        signal: abortController.signal,
      });
      if (flags.json) console.log(JSON.stringify(rows));
      else for (const row of rows) console.log(formatListLine(row));
      return 0;
    }

    return 2;
  } catch (error) {
    if (abortController.signal.aborted) return 130;
    if (error instanceof CliUsageError) {
      warn(error.message);
      return 2;
    }
    warn(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
