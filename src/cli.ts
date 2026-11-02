import packageJson from "../package.json";
import { sourceNotes } from "./discover";
import {
  addAddon,
  addonInfo,
  adoptAddons,
  findAddons,
  listCategories,
  listRows,
  listUntracked,
  openContext,
  type Query,
  type Removal,
  removeAddon,
  syncAddons,
} from "./service";
import {
  type AddonInfo,
  type Context,
  type Flavor,
  type Listing,
  type Progress,
  type Row,
  type SourceKind,
  type SourceReport,
  WowaddonError,
} from "./types";

const VERSION = packageJson.version;
// Bumped only when a documented field of the JSON output changes meaning or goes away.
const SCHEMA_VERSION = 1;

const exitCodes = { ok: 0, failed: 1, usage: 2, locked: 3, interrupted: 130 } as const;
const exitMeanings: Record<keyof typeof exitCodes, string> = {
  ok: "done; dev-link skips count as success",
  failed: "an addon or the operation failed; see FAIL lines or the error code",
  usage: "usage or configuration error; fix the command or config and rerun",
  locked: "another wowaddon run holds this flavor's lock; wait and retry",
  interrupted: "cancelled with Ctrl+C",
};

interface Flag {
  help: string;
  value?: string;
}
interface CommandSpec {
  args: string;
  summary: string;
  flags: Record<string, Flag>;
  output: string;
}
const adopt: Flag = { help: "take over a folder that was installed outside wowaddon" };
const dryRun: Flag = {
  help: "report what would change; the manifest, state and AddOns stay as they are",
};
const discoveryFlags: Record<string, Flag> = {
  category: { help: "only this category (see wowaddon categories)", value: "NAME" },
  source: { help: "only these sources, comma separated: cf,gh,wowi,tukui", value: "LIST" },
  limit: { help: "results per page, 1 to 50 (default 20)", value: "N" },
  page: { help: "page number, from 1; each source returns its own Nth page", value: "N" },
  "all-flavors": { help: "include addons that do not list this flavor" },
};
const specs: Record<string, CommandSpec> = {
  sync: {
    args: "[<id|ref>...]",
    summary: "install missing addons and update outdated ones, backing up WTF first",
    flags: {
      adopt,
      "dry-run": dryRun,
      "no-backup": { help: "skip the WTF snapshot taken before the first change" },
    },
    output: "{ ...envelope, dryRun: boolean, backup: string | null, addons: Row[] }",
  },
  check: {
    args: "[<id|ref>...]",
    summary: "report which addons sync would install or update; installs nothing",
    flags: {},
    output: "{ ...envelope, updates: number, addons: Row[], untracked: { folder, title? }[] }",
  },
  add: {
    args: "<ref|url> | <kind> <ref>",
    summary: "add an addon to the manifest and install it",
    flags: {
      note: { help: "manifest comment for the addon", value: "TEXT" },
      "no-install": { help: "only write the manifest line" },
      adopt,
      "dry-run": dryRun,
    },
    output: "{ ...envelope, dryRun: boolean, addon: Row }",
  },
  remove: {
    args: "<id|ref>",
    summary: "remove an addon and its folders; a dev link is only untracked",
    flags: { "dry-run": dryRun },
    output: "{ ...envelope, dryRun: boolean, removed: { entry, installed?, deleted: boolean } }",
  },
  list: {
    args: "",
    summary: "list managed addons from local state",
    flags: { refresh: { help: "also resolve each addon's latest release" } },
    output: "{ ...envelope, addons: Row[] }",
  },
  search: {
    args: "<text...>",
    summary: "search every keyless source for addons this flavor can load; refs go straight to add",
    flags: {
      sort: { help: "relevance (default), downloads, updated or name", value: "ORDER" },
      ...discoveryFlags,
    },
    output:
      "{ ...envelope, query: string, sort: string, category: string | null, page: number, results: Listing[], sources: SourceReport[] }",
  },
  browse: {
    args: "[popular|trending|updated|name]",
    summary: "list the most downloaded (default), trending, recently updated or A-Z addons",
    flags: discoveryFlags,
    output:
      "{ ...envelope, mode: string, category: string | null, page: number, results: Listing[], sources: SourceReport[] }",
  },
  info: {
    args: "<ref|url>",
    summary:
      "one addon's page: summary, authors, downloads, last update, game versions, categories, links, folders, changelog",
    flags: {},
    output: "{ ...envelope, addon: AddonInfo }",
  },
  categories: {
    args: "",
    summary: "list the categories browse and search --category accept, per source",
    flags: {},
    output: "{ ...envelope, categories: Category[], sources: SourceReport[] }",
  },
  adopt: {
    args: "",
    summary:
      "take over installed addons wowaddon does not manage yet, matched by WowUp's records, TOC project IDs or title",
    flags: {
      wowup: { help: "WowUp data folder to read (default: found automatically)", value: "PATH" },
      "no-wowup": { help: "ignore WowUp's records" },
      "dry-run": { help: "report the matches; the manifest, state and AddOns stay as they are" },
      "no-backup": { help: "skip the WTF snapshot taken before the first change" },
    },
    output:
      "{ ...envelope, dryRun: boolean, wowup: { path, installation } | null, backup: string | null, matches: Match[], addons: Row[], unmatched: { folder, title?, reason }[], skipped: { folder, reason }[] }",
  },
  schema: {
    args: "",
    summary: "describe commands, flags, JSON output and exit codes as JSON",
    flags: {},
    output: "this document",
  },
};
const globalFlags: Record<string, Flag> = {
  flavor: { help: "client flavor (default: config, then era)", value: "era|forever" },
  "addons-dir": { help: "AddOns folder to manage", value: "PATH" },
  json: { help: "print exactly one JSON document on stdout; progress stays on stderr" },
};

function flagUsage(name: string, flag: Flag): string {
  return `--${name}${flag.value ? ` ${flag.value}` : ""}`;
}
function usage(name: string): string {
  const spec = specs[name];
  return [
    `wowaddon ${name}`,
    spec.args,
    ...Object.entries(spec.flags).map(([flag, value]) => `[${flagUsage(flag, value)}]`),
  ]
    .filter(Boolean)
    .join(" ");
}
const HELP = `wowaddon: manage WoW addons from GitHub, CurseForge, WoWInterface, Tukui and Wago Addons

Usage:
  wowaddon                 TUI if the terminal supports it, else sync
${Object.keys(specs)
  .map((name) => `  ${usage(name)}\n      ${specs[name].summary}`)
  .join("\n")}

Global options:
${Object.entries(globalFlags)
  .map(([name, flag]) => `  ${flagUsage(name, flag).padEnd(24)} ${flag.help}`)
  .join("\n")}
  ${"-h, --help".padEnd(24)} show this help
  ${"-V, --version".padEnd(24)} show the version

Finding addons (search, browse, info) per source:
${Object.entries(sourceNotes)
  .map(([kind, note]) => `  ${kind.padEnd(6)} ${note.via}.\n         Gaps: ${note.gaps}.`)
  .join("\n")}

Exit codes: ${Object.entries(exitCodes)
  .map(([name, code]) => `${code} ${name}`)
  .join(", ")}. Run wowaddon schema for the JSON output shapes.
`;

const statuses: Record<Row["status"], string> = {
  missing: "not installed; sync installs it",
  update: "installed, and a newer release exists; sync updates it",
  current: "installed at the latest release",
  unknown: "installed; latest release not resolved (list without --refresh)",
  dev: "a dev link (symlink, git checkout or worktree); never touched",
  unmanaged: "its folder exists but was installed outside wowaddon; sync needs --adopt",
  error: "failed; message and code say why",
};
const errorCodes: Record<string, string> = {
  USAGE: "bad command line",
  CONFIG_MISSING: "no AddOns folder found; pass --addons-dir",
  CONFIG_AMBIGUOUS: "several AddOns folders found; pass --addons-dir",
  CONFIG_INVALID: "config.json is invalid",
  LOCKED: "another wowaddon run holds the lock; retry",
  NOT_FOUND: "the addon is not in the manifest",
  DUPLICATE: "the addon is already in the manifest",
  INVALID_REF: "unrecognised addon reference",
  UNMANAGED: "folder installed outside wowaddon; rerun with --adopt if the user agrees",
  NO_BUILD: "the source has no build for this flavor",
  WAGO_KEY_MISSING: "Wago Addons needs WAGO_ADDONS_API_KEY or a wago_token file",
  WAGO_KEY_INVALID: "Wago Addons rejected the API key",
  BACKUP_FAILED: "the WTF snapshot failed, so sync changed nothing",
  SOURCE_RESPONSE: "a source returned data wowaddon could not read",
  CATEGORY: "a source has no category of that name (a skipped source in sources)",
  NO_CATEGORIES: "a source has no categories (a skipped source in sources)",
  NO_FLAVOR_TAG: "a source cannot tell which addons support this flavor (a skipped source)",
  WOWUP_MISSING: "no WowUp addons.json in the --wowup folder",
  WOWUP_INVALID: "WowUp's data could not be read",
  ABORTED: "cancelled",
};

function schema() {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: VERSION,
    commands: Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => [
        name,
        { usage: usage(name), summary: spec.summary, flags: spec.flags, output: spec.output },
      ]),
    ),
    globalFlags,
    output: {
      envelope:
        "{ schemaVersion: number, command: string, flavor: 'era' | 'forever', addonsDir: string }",
      Row: "{ entry: { id, kind, ref, note? }, installed?: { version, versionKey, folders, installedAt }, latest?: { version, versionKey, url, archive, note? }, status, message?, code? }",
      error:
        "{ schemaVersion, command, error: { code: string, message: string } } on stdout, with a non-zero exit",
      Listing:
        "{ ref: string (add takes it as is), kind, name, summary, authors: string[], downloads: number | null, updated: ISO string | null, categories: string[], gameVersions: string[], flavors: ('era' | 'forever')[], url }",
      AddonInfo:
        "Listing & { version: string | null, links: { website?, source?, issues?, wiki?, homepage?, donate? }, folders: string[], description: string, changelog: { version: string | null, text: string } | null }",
      SourceReport:
        "{ kind, status: 'ok' | 'skipped' | 'failed', count: number, code?, message? }: one per source, so a failed source never hides the others",
      Category: "{ kind, id, name, parent?, count? }",
      Match:
        "{ entry, folders: string[], matchedBy: 'manifest' | 'wowup' | 'toc' | 'title', inManifest: boolean, conflicts: string[] }",
    },
    sources: sourceNotes,
    statuses,
    errorCodes,
    exitCodes: Object.fromEntries(
      Object.entries(exitCodes).map(([name, code]) => [
        name,
        { code, meaning: exitMeanings[name as keyof typeof exitCodes] },
      ]),
    ),
    environment: {
      GH_TOKEN: "GitHub token, sent only to api.github.com",
      CF_API_KEY: "optional CurseForge key, sent only to api.curseforge.com",
      WAGO_ADDONS_API_KEY: "Wago Addons key, sent only to addons.wago.io",
    },
  };
}

class CliUsageError extends Error {}
function usageError(message: string): never {
  throw new CliUsageError(message);
}

export interface Globals {
  flavor?: Flavor;
  addonsDir?: string;
}

interface ParsedArgs {
  globals: Globals;
  command?: string;
  rest: string[];
  json: boolean;
  help: boolean;
  version: boolean;
}

function isFlavor(value: string): value is Flavor {
  return value === "era" || value === "forever";
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { globals: {}, rest: [], json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "-V" || arg === "--version") parsed.version = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--flavor" || arg.startsWith("--flavor=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!value || !isFlavor(value))
        usageError(`--flavor must be era or forever, got: ${value ?? ""}`);
      parsed.globals.flavor = value;
    } else if (arg === "--addons-dir" || arg.startsWith("--addons-dir=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!value) usageError("--addons-dir requires a path");
      parsed.globals.addonsDir = value;
    } else if (parsed.command === undefined && !arg.startsWith("-")) parsed.command = arg;
    else parsed.rest.push(arg);
  }
  return parsed;
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

function formatRemoval(removal: Removal, dryRun: boolean): string {
  const id = removal.entry.id;
  const folders = removal.installed?.folders.join(", ");
  if (dryRun)
    return removal.deleted
      ? `WOULD remove ${id} and delete ${folders}`
      : `WOULD remove ${id}${folders ? `; ${folders} stays (dev link)` : ""}`;
  return `OK   removed ${id}${!removal.deleted && folders ? `; ${folders} kept (dev link)` : ""}`;
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
  return rows.some((row) => row.status === "error") ? exitCodes.failed : exitCodes.ok;
}

function splitFlags(
  command: string,
  args: string[],
): { flags: Record<string, string | boolean>; positionals: string[] } {
  const known = specs[command].flags;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!Object.hasOwn(known, name)) usageError(`unknown option: ${arg}`);
    if (known[name].value) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined) usageError(`--${name} requires a value`);
      flags[name] = value;
    } else flags[name] = true;
  }
  return { flags, positionals };
}

const kinds: SourceKind[] = ["cf", "gh", "wowi", "tukui", "wago"];
function count(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: number,
  max: number,
) {
  const value = flags[name];
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    usageError(`--${name} must be a whole number from 1 to ${max}`);
  return n;
}
function discoveryQuery(
  flags: Record<string, string | boolean>,
  order: Query["order"],
  text?: string,
): { query: Query; sources?: SourceKind[] } {
  const sources =
    typeof flags.source === "string"
      ? flags.source.split(",").map((kind) => kind.trim().toLowerCase())
      : undefined;
  for (const kind of sources ?? [])
    if (!kinds.includes(kind as SourceKind))
      usageError(`--source takes ${kinds.join(", ")}, got: ${kind}`);
  return {
    query: {
      ...(text ? { text } : {}),
      order,
      ...(typeof flags.category === "string" ? { category: flags.category } : {}),
      limit: count(flags, "limit", 20, 50),
      page: count(flags, "page", 1, 100),
      allFlavors: Boolean(flags["all-flavors"]),
    },
    sources: sources as SourceKind[] | undefined,
  };
}
const compact = (n: number | null) =>
  n === null
    ? "-"
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : String(n);
function formatListing(listing: Listing): string {
  return [
    listing.ref.padEnd(28),
    (listing.name.length > 32 ? `${listing.name.slice(0, 31)}…` : listing.name).padEnd(32),
    compact(listing.downloads).padStart(7),
    (listing.updated ?? "").slice(0, 10).padEnd(10),
    listing.summary.slice(0, 80),
  ]
    .join(" ")
    .trimEnd();
}
// Skipped and failed sources go to stderr, so a person sees why a source is missing from the list.
function reportSources(sources: SourceReport[]): void {
  for (const source of sources)
    if (source.status !== "ok") warn(`${source.kind} ${source.status}: ${source.message ?? ""}`);
}
function formatInfo(addon: AddonInfo): string[] {
  const lines = [
    `${addon.name}  ${addon.ref}`,
    addon.summary,
    `by ${addon.authors.join(", ") || "unknown"} · ${compact(addon.downloads)} downloads · updated ${(addon.updated ?? "unknown").slice(0, 10)} · latest ${addon.version ?? "unknown"}`,
    `flavors: ${addon.flavors.join(", ") || "unknown"} · game versions: ${addon.gameVersions.join(", ") || "unknown"}`,
  ];
  if (addon.categories.length) lines.push(`categories: ${addon.categories.join(", ")}`);
  if (addon.folders.length) lines.push(`folders: ${addon.folders.join(", ")}`);
  for (const [name, url] of Object.entries(addon.links)) lines.push(`${name}: ${url}`);
  if (addon.changelog)
    lines.push(
      "",
      `changelog${addon.changelog.version ? ` ${addon.changelog.version}` : ""}:`,
      addon.changelog.text,
    );
  return lines.filter((line, index) => index !== 1 || line);
}

// The TUI opens with the same --flavor / --addons-dir the command line was given.
export function tuiOptions(argv: string[]): Globals {
  return parseArgs(argv).globals;
}

// A command returns its JSON fields, the plain lines for a person, and its exit code.
interface Outcome {
  data: Record<string, unknown>;
  lines: string[];
  code: number;
}
type CommandHandler = (ctx: Context, args: string[], signal: AbortSignal) => Promise<Outcome>;

const commands: Record<string, CommandHandler> = {
  async search(ctx, args, signal) {
    const { flags, positionals } = splitFlags("search", args);
    const text = positionals.join(" ").trim();
    if (!text) usageError(`usage: ${usage("search")}`);
    const sort = flags.sort ?? "relevance";
    if (!["relevance", "downloads", "updated", "name"].includes(String(sort)))
      usageError(`--sort takes relevance, downloads, updated or name, got: ${sort}`);
    const { query, sources } = discoveryQuery(flags, sort as Query["order"], text);
    const found = await findAddons(ctx, query, { sources, signal });
    reportSources(found.sources);
    return {
      data: {
        query: text,
        sort,
        category: query.category ?? null,
        page: query.page,
        results: found.results,
        sources: found.sources,
      },
      lines: found.results.length ? found.results.map(formatListing) : ["no addons found"],
      code: found.sources.every((source) => source.status === "failed")
        ? exitCodes.failed
        : exitCodes.ok,
    };
  },

  async browse(ctx, args, signal) {
    const { flags, positionals } = splitFlags("browse", args);
    const modes: Record<string, Query["order"]> = {
      popular: "downloads",
      trending: "trending",
      updated: "updated",
      name: "name",
    };
    const mode = positionals[0] ?? "popular";
    if (positionals.length > 1 || !Object.hasOwn(modes, mode))
      usageError(`usage: ${usage("browse")}`);
    const { query, sources } = discoveryQuery(flags, modes[mode]);
    const found = await findAddons(ctx, query, { sources, signal });
    reportSources(found.sources);
    return {
      data: {
        mode,
        category: query.category ?? null,
        page: query.page,
        results: found.results,
        sources: found.sources,
      },
      lines: found.results.length ? found.results.map(formatListing) : ["no addons found"],
      code: found.sources.every((source) => source.status === "failed")
        ? exitCodes.failed
        : exitCodes.ok,
    };
  },

  async info(ctx, args, signal) {
    const { positionals } = splitFlags("info", args);
    if (positionals.length !== 1) usageError(`usage: ${usage("info")}`);
    const addon = await addonInfo(ctx, positionals[0], signal);
    return { data: { addon }, lines: formatInfo(addon), code: exitCodes.ok };
  },

  async categories(ctx, args, signal) {
    const { positionals } = splitFlags("categories", args);
    if (positionals.length) usageError(`usage: ${usage("categories")}`);
    const found = await listCategories(ctx, signal);
    reportSources(found.sources);
    return {
      data: found,
      lines: found.categories.map(
        (category) =>
          `${category.kind.padEnd(6)} ${category.parent ? `${category.parent} / ` : ""}${category.name}${category.count ? ` (${category.count})` : ""}`,
      ),
      code: found.sources.every((source) => source.status !== "ok")
        ? exitCodes.failed
        : exitCodes.ok,
    };
  },

  async adopt(ctx, args, signal) {
    const { flags, positionals } = splitFlags("adopt", args);
    if (positionals.length) usageError(`usage: ${usage("adopt")}`);
    const dryRun = Boolean(flags["dry-run"]);
    const { plan, rows, backup } = await adoptAddons(ctx, {
      wowup: flags["no-wowup"] ? false : typeof flags.wowup === "string" ? flags.wowup : undefined,
      dryRun,
      backup: !flags["no-backup"],
      signal,
      onProgress: logProgress,
    });
    if (backup) warn(`Backed up WTF to ${backup}`);
    if (plan.wowup) warn(`Read WowUp's ${plan.wowup.installation} addons from ${plan.wowup.path}`);
    const lines = [
      ...plan.matches.map(
        (match) =>
          `${dryRun ? "WOULD adopt" : "ADOPT"} ${match.entry.id} ${match.entry.note ?? ""} [${match.folders.join(", ")}] by ${match.matchedBy}${match.conflicts.length ? `; also claimed by ${match.conflicts.join(", ")}` : ""}`,
      ),
      ...rows.map(formatResultLine),
      ...plan.unmatched.map(
        (item) => `UNMATCHED ${item.folder}${item.title ? ` (${item.title})` : ""}: ${item.reason}`,
      ),
      ...plan.skipped.map((item) => `SKIP ${item.folder}: ${item.reason}`),
    ];
    return {
      data: {
        dryRun,
        wowup: plan.wowup,
        backup: backup ?? null,
        matches: plan.matches,
        addons: rows,
        unmatched: plan.unmatched,
        skipped: plan.skipped,
      },
      lines: lines.length ? lines : ["nothing to adopt: every installed addon is managed"],
      code: summarizeExit(rows),
    };
  },

  async sync(ctx, args, signal) {
    const { flags, positionals } = splitFlags("sync", args);
    if (flags["dry-run"]) {
      const rows = await listRows(ctx, { refresh: true, ids: positionals, signal });
      return {
        data: { dryRun: true, backup: null, addons: rows },
        lines: rows.map(formatListLine),
        code: summarizeExit(rows),
      };
    }
    const { rows, backup } = await syncAddons(ctx, {
      ids: positionals,
      adopt: Boolean(flags.adopt),
      backup: !flags["no-backup"],
      signal,
      onProgress: logProgress,
    });
    if (backup) warn(`Backed up WTF to ${backup}`);
    return {
      data: { dryRun: false, backup: backup ?? null, addons: rows },
      lines: rows.map(formatResultLine),
      code: summarizeExit(rows),
    };
  },

  async check(ctx, args, signal) {
    const { positionals } = splitFlags("check", args);
    const rows = await listRows(ctx, { refresh: true, ids: positionals, signal });
    const updates = rows.filter((row) => row.status === "missing" || row.status === "update");
    const shown = rows.filter((row) => row.status !== "current");
    const untracked = positionals.length
      ? []
      : (await listUntracked(ctx)).map(({ folder, title }) => ({
          folder,
          ...(title ? { title } : {}),
        }));
    return {
      data: { updates: updates.length, addons: rows, untracked },
      lines: [
        ...(shown.length ? shown.map(formatListLine) : [`all ${rows.length} addons are current`]),
        ...untracked.map(
          (item) =>
            `UNTRACKED ${item.folder}${item.title ? ` (${item.title})` : ""}: wowaddon adopt takes it over`,
        ),
      ],
      code: summarizeExit(rows),
    };
  },

  async add(ctx, args, signal) {
    const { flags, positionals } = splitFlags("add", args);
    if (!positionals.length) usageError(`usage: ${usage("add")}`);
    const dryRun = Boolean(flags["dry-run"]);
    const row = await addAddon(ctx, positionals.join(" "), {
      note: typeof flags.note === "string" ? flags.note : undefined,
      install: !flags["no-install"],
      adopt: Boolean(flags.adopt),
      dryRun,
      signal,
      onProgress: logProgress,
    });
    return {
      data: { dryRun, addon: row },
      lines: [dryRun ? formatListLine(row) : formatResultLine(row)],
      code: summarizeExit([row]),
    };
  },

  async remove(ctx, args, signal) {
    const { flags, positionals } = splitFlags("remove", args);
    if (!positionals.length) usageError(`usage: ${usage("remove")}`);
    const dryRun = Boolean(flags["dry-run"]);
    const removed = await removeAddon(ctx, positionals.join(" "), { dryRun, signal });
    return {
      data: { dryRun, removed },
      lines: [formatRemoval(removed, dryRun)],
      code: exitCodes.ok,
    };
  },

  async list(ctx, args, signal) {
    const { flags, positionals } = splitFlags("list", args);
    if (positionals.length) usageError(`usage: ${usage("list")}`);
    const rows = await listRows(ctx, { refresh: Boolean(flags.refresh), signal });
    return { data: { addons: rows }, lines: rows.map(formatListLine), code: exitCodes.ok };
  },
};

function failure(error: unknown, aborted: boolean): { code: string; exit: number } {
  if (aborted) return { code: "ABORTED", exit: exitCodes.interrupted };
  if (error instanceof CliUsageError) return { code: "USAGE", exit: exitCodes.usage };
  if (!(error instanceof WowaddonError)) return { code: "ERROR", exit: exitCodes.failed };
  if (error.code === "LOCKED") return { code: error.code, exit: exitCodes.locked };
  return {
    code: error.code,
    exit: error.code.startsWith("CONFIG_") ? exitCodes.usage : exitCodes.failed,
  };
}

export async function runCli(argv: string[]): Promise<number | undefined> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json"))
      console.log(
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, error: { code: "USAGE", message } }),
      );
    else warn(message);
    return exitCodes.usage;
  }

  if (parsed.help) {
    console.log(HELP);
    return exitCodes.ok;
  }
  if (parsed.version) {
    console.log(`wowaddon ${VERSION}`);
    return exitCodes.ok;
  }

  const command =
    parsed.command ?? (process.stdin.isTTY && process.stdout.isTTY ? undefined : "sync");
  if (command === undefined) return undefined;
  if (command === "schema") {
    console.log(JSON.stringify(schema(), null, 2));
    return exitCodes.ok;
  }

  const fail = (error: unknown, aborted: boolean, forceExit?: number): number => {
    const { code, exit } = failure(error, aborted);
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json)
      console.log(
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, error: { code, message } }),
      );
    else if (!aborted) warn(message);
    return forceExit ?? exit;
  };

  if (!Object.hasOwn(commands, command)) {
    if (parsed.json) return fail(new CliUsageError(`unknown command: ${command}`), false);
    warn(`unknown command: ${command}\n\n${HELP}`);
    return exitCodes.usage;
  }

  const abortController = new AbortController();
  const onSigint = () => abortController.abort();
  process.once("SIGINT", onSigint);
  try {
    let ctx: Context;
    try {
      ctx = await openContext({
        flavor: parsed.globals.flavor,
        addonsDir: parsed.globals.addonsDir,
        env: process.env,
      });
    } catch (error) {
      const aborted = abortController.signal.aborted;
      return fail(error, aborted, aborted ? exitCodes.interrupted : exitCodes.usage);
    }
    for (const notice of ctx.notices) warn(notice);
    try {
      const outcome = await commands[command](ctx, parsed.rest, abortController.signal);
      if (parsed.json)
        console.log(
          JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            command,
            flavor: ctx.flavor,
            addonsDir: ctx.addonsDir,
            ...outcome.data,
          }),
        );
      else for (const line of outcome.lines) console.log(line);
      return outcome.code;
    } catch (error) {
      return fail(error, abortController.signal.aborted);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
