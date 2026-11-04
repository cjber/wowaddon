import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json";
import { contextEnv, isMissing } from "./config";
import { getCredentials, requestJson } from "./http";
import { atomicWrite } from "./state";
import type { Context, Entry, Installed, Release, Row } from "./types";

// Interactive runs check for a newer wowaddon and refresh each addon's latest release without
// waiting: a detached worker does the network work and leaves the result in a cache the next run
// reads. Each check backs off on its own: a success waits its interval, a failure retries after
// 15 minutes, doubling up to a day.
export const BACKGROUND_COMMAND = "__background";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const INTERVALS = { self: 6 * HOUR, addons: HOUR };
const RETRY_FIRST = 15 * MINUTE;
const RETRY_MAX = 24 * HOUR;
const LEASE_MS = 10 * MINUTE;
// A release older than this is no longer trusted to say current or update.
const CACHE_MAX_AGE = 7 * 24 * HOUR;
const RELEASES_URL = "https://github.com/cjber/wowaddon/releases";

export interface Schedule {
  nextAt: number;
  failures: number;
}
// One file per check, so the self check, a foreground refresh and another flavor's worker never
// overwrite each other's record.
interface Check extends Schedule {
  latestVersion?: string;
}
interface CachedRelease {
  release: Release;
  fetchedAt: number;
}
type CheckKey = "self" | `addons:${string}`;

const cacheDir = (ctx: Context) => join(ctx.configDir, "cache");
const checkPath = (ctx: Context, key: CheckKey) =>
  join(cacheDir(ctx), "checks", `${key.replace(":", "-")}.json`);
const releasesPath = (ctx: Context) => join(cacheDir(ctx), `releases-${ctx.flavor}.json`);
const leasePath = (ctx: Context) => join(cacheDir(ctx), "background.lease");
const addonsKey = (ctx: Context): CheckKey => `addons:${ctx.flavor}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    return isRecord(data) ? data : {};
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return {};
    throw error;
  }
}
async function readCheck(ctx: Context, key: CheckKey): Promise<Check | undefined> {
  const data = await readJson(checkPath(ctx, key));
  if (!Number.isFinite(data.nextAt) || !Number.isFinite(data.failures)) return undefined;
  return {
    nextAt: Number(data.nextAt),
    failures: Number(data.failures),
    ...(typeof data.latestVersion === "string" ? { latestVersion: data.latestVersion } : {}),
  };
}

export function nextSchedule(
  previous: Schedule | undefined,
  ok: boolean,
  interval: number,
  now: number,
): Schedule {
  if (ok) return { nextAt: now + interval, failures: 0 };
  const failures = (previous?.failures ?? 0) + 1;
  return { nextAt: now + Math.min(RETRY_FIRST * 2 ** (failures - 1), RETRY_MAX), failures };
}
async function settle(
  ctx: Context,
  key: CheckKey,
  ok: boolean,
  now: number,
  found: { latestVersion?: string } = {},
): Promise<void> {
  const previous = await readCheck(ctx, key);
  const interval = key === "self" ? INTERVALS.self : INTERVALS.addons;
  const check: Check = { ...previous, ...found, ...nextSchedule(previous, ok, interval, now) };
  await mkdir(join(cacheDir(ctx), "checks"), { recursive: true });
  await atomicWrite(checkPath(ctx, key), `${JSON.stringify(check, null, 2)}\n`);
}

// Release caches -------------------------------------------------------------------------------

async function readReleases(ctx: Context): Promise<Record<string, CachedRelease>> {
  const data = await readJson(releasesPath(ctx));
  const releases: Record<string, CachedRelease> = {};
  for (const [id, value] of Object.entries(data)) {
    if (!isRecord(value) || !Number.isFinite(value.fetchedAt) || !isRecord(value.release)) continue;
    const { version, versionKey } = value.release;
    if (typeof version === "string" && typeof versionKey === "string")
      releases[id] = {
        release: value.release as unknown as Release,
        fetchedAt: Number(value.fetchedAt),
      };
  }
  return releases;
}

// A cached release says current or update only when it was fetched after the addon was installed
// and is recent; otherwise the row stays unknown, as without a cache.
export async function cachedReleases(
  ctx: Context,
  now = Date.now(),
): Promise<(entry: Entry, installed?: Installed) => Release | undefined> {
  const releases = await readReleases(ctx).catch(() => ({}) as Record<string, CachedRelease>);
  return (entry, installed) => {
    const cached = releases[entry.id];
    if (!cached || now - cached.fetchedAt > CACHE_MAX_AGE) return undefined;
    const installedAt = installed ? Date.parse(installed.installedAt) : Number.NaN;
    return Number.isFinite(installedAt) && cached.fetchedAt < installedAt
      ? undefined
      : cached.release;
  };
}

// Rows resolved by a refresh or a sync, fetched at `now`: a refresh passes the time it started, so
// an install that lands while it runs is newer than the fetch and the row stays unknown. A refresh of the whole manifest also counts as this
// flavor's addon check, so no worker repeats it; when every row failed it counts as a failure.
export async function recordReleases(
  ctx: Context,
  rows: Row[],
  opts: { complete: boolean },
  now = Date.now(),
): Promise<void> {
  try {
    const previous = await readReleases(ctx);
    // A complete refresh drops addons that left the manifest; a row that failed keeps its last
    // release, which ages out on its own.
    const releases = opts.complete
      ? Object.fromEntries(
          rows.flatMap(({ entry }) => (previous[entry.id] ? [[entry.id, previous[entry.id]]] : [])),
        )
      : previous;
    let resolved = 0;
    for (const { entry, latest } of rows)
      if (latest) {
        releases[entry.id] = { release: latest, fetchedAt: now };
        resolved++;
      }
    await mkdir(cacheDir(ctx), { recursive: true });
    await atomicWrite(releasesPath(ctx), `${JSON.stringify(releases, null, 2)}\n`);
    if (opts.complete) await settle(ctx, addonsKey(ctx), !rows.length || resolved > 0, now);
  } catch {
    // The cache only saves a later lookup; a failed write never fails the command.
  }
}

// Self update ----------------------------------------------------------------------------------

function parseVersion(text: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
// The one-line notice for a newer wowaddon, from the cache alone.
export async function updateNotice(
  ctx: Context,
  current: string = packageJson.version,
): Promise<string | undefined> {
  try {
    if (contextEnv(ctx).WOWADDON_NO_UPDATE_CHECK) return undefined;
    const latestVersion = (await readCheck(ctx, "self"))?.latestVersion;
    if (!latestVersion || !isNewer(latestVersion, current)) return undefined;
    return `wowaddon ${latestVersion.replace(/^v/, "")} is available (you have ${current}): ${RELEASES_URL}`;
  } catch {
    return undefined;
  }
}
async function latestSelfVersion(ctx: Context): Promise<string> {
  const credentials = await getCredentials(ctx);
  const release = await requestJson<{ tag_name?: unknown }>(
    "https://api.github.com/repos/cjber/wowaddon/releases/latest",
    { credentials },
  );
  if (typeof release.tag_name !== "string" || !parseVersion(release.tag_name))
    throw new Error("unexpected release tag");
  return release.tag_name;
}

// Launching and running the worker ---------------------------------------------------------------

export function backgroundEnabled(ctx: Context, interactive = Boolean(process.stderr.isTTY)) {
  return interactive && !contextEnv(ctx).WOWADDON_NO_UPDATE_CHECK;
}
// The command line that runs this program again: a compiled binary is its own entry point, a
// source run passes the script to bun.
export function selfCommand(main = Bun.main, execPath = process.execPath): string[] {
  return main.startsWith("/$bunfs/") ? [execPath] : [execPath, main];
}
type Launch = (argv: string[]) => void;
const launchDetached: Launch = ([command, ...args]) => {
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
};
let launch = launchDetached;
// Tests swap the launcher out, as setFetch does for the network.
export function setLaunch(value?: Launch): void {
  launch = value ?? launchDetached;
}

// Starts a worker for every check that is due and returns at once; it never throws.
export async function startBackgroundChecks(
  ctx: Context,
  opts: { addons: boolean; interactive?: boolean; now?: number },
): Promise<void> {
  try {
    if (!backgroundEnabled(ctx, opts.interactive)) return;
    const now = opts.now ?? Date.now();
    const keys: CheckKey[] = [];
    for (const key of ["self", ...(opts.addons ? [addonsKey(ctx)] : [])] as CheckKey[])
      if (((await readCheck(ctx, key))?.nextAt ?? 0) <= now) keys.push(key);
    if (!keys.length) return;
    launch([
      ...selfCommand(),
      BACKGROUND_COMMAND,
      "--flavor",
      ctx.flavor,
      "--addons-dir",
      ctx.addonsDir,
      ...keys,
    ]);
  } catch {
    // An update check never fails or delays the command that started it.
  }
}

// One worker at a time across every run: the lease file is created exclusively and recovered
// only once it has expired.
async function takeLease(ctx: Context, now: number): Promise<string | undefined> {
  await mkdir(cacheDir(ctx), { recursive: true });
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(leasePath(ctx), "wx");
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, until: now + LEASE_MS }));
      await handle.close();
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lease = await readJson(leasePath(ctx));
      if (Number.isFinite(lease.until) && Number(lease.until) > now) return undefined;
      await rm(leasePath(ctx), { force: true });
    }
  }
  return undefined;
}
// A worker that outlived its lease leaves the newer worker's lease alone.
async function releaseLease(ctx: Context, token: string): Promise<void> {
  const lease = await readJson(leasePath(ctx)).catch((): Record<string, unknown> => ({}));
  if (lease.token === token) await rm(leasePath(ctx), { force: true });
}

export async function runBackground(
  ctx: Context,
  keys: string[],
  refreshAddons: (ctx: Context) => Promise<unknown>,
  now = Date.now(),
): Promise<void> {
  const token = await takeLease(ctx, now);
  if (!token) return;
  try {
    for (const key of keys) {
      if (key === "self")
        await latestSelfVersion(ctx).then(
          (latestVersion) => settle(ctx, "self", true, Date.now(), { latestVersion }),
          () => settle(ctx, "self", false, Date.now()),
        );
      else if (key === addonsKey(ctx))
        // A complete refresh records its releases and settles the schedule itself.
        await refreshAddons(ctx).catch(() => settle(ctx, key, false, Date.now()));
    }
  } finally {
    await releaseLease(ctx, token);
  }
}
