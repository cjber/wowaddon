import { type AdoptionPlan, planAdoption, type Untracked, untrackedFolders } from "./adopt";
import { backupWtf } from "./backup";
import { openContext as openConfiguredContext } from "./config";
import { categories, discover, type Query, addonInfo as sourceInfo } from "./discover";
import { checkAbort } from "./http";
import {
  beginProtectionChecks,
  DEV_SKIPPED,
  foldersFree,
  foldersPresent,
  foreignFolders,
  type InstallOptions,
  installAddon,
  isProtected,
  removeInstalled,
  withInstallLock,
} from "./install";
import { readManifest, writeManifest } from "./manifest";
import { canonicalId, parseRef as parseAddonRef } from "./refs";
import { cachedCfId, resolveCfProject, resolveCurseforge } from "./sources/curseforge";
import { resolveGithub } from "./sources/github";
import { resolveTukui } from "./sources/tukui";
import { resolveWago } from "./sources/wago";
import { resolveWowinterface } from "./sources/wowinterface";
import { readState, type State } from "./state";
import {
  type AddonInfo,
  type Category,
  type Context,
  type Entry,
  type Flavor,
  type Installed,
  type Listing,
  type Progress,
  type Release,
  type Row,
  type SourceKind,
  type SourceReport,
  WowaddonError,
} from "./types";

export async function openContext(opts: {
  flavor?: Flavor;
  addonsDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Context> {
  return openConfiguredContext(opts);
}
export function parseRef(input: string): { kind: SourceKind; ref: string } {
  return parseAddonRef(input);
}

async function entries(ctx: Context, refresh: boolean, signal?: AbortSignal) {
  const errors = new Map<string, unknown>();
  const manifest = await readManifest(ctx, async (slug) => {
    try {
      return refresh ? (await resolveCfProject(ctx, slug, signal)).id : await cachedCfId(ctx, slug);
    } catch (error) {
      checkAbort(signal);
      errors.set(`cf:${slug}`, error);
      return slug;
    }
  });
  return { manifest, errors };
}
const resolvers: Record<
  SourceKind,
  (ctx: Context, ref: string, signal?: AbortSignal) => Promise<Release>
> = {
  gh: resolveGithub,
  cf: resolveCurseforge,
  wowi: resolveWowinterface,
  tukui: resolveTukui,
  wago: resolveWago,
};
async function latest(ctx: Context, entry: Entry, signal?: AbortSignal): Promise<Release> {
  checkAbort(signal);
  return resolvers[entry.kind](ctx, entry.ref, signal);
}
// A dry run reads state without the install lock, so it never recovers or changes anything.
function withState<T>(
  ctx: Context,
  dryRun: boolean | undefined,
  work: (state: State) => Promise<T>,
) {
  return dryRun ? readState(ctx).then(work) : withInstallLock(ctx, work);
}
// What sync would do to one entry, from local folders and, when given, its latest release.
async function statusRow(
  ctx: Context,
  entry: Entry,
  installed: Installed | undefined,
  release?: () => Promise<Release>,
): Promise<Row> {
  if (await isProtected(ctx, entry, installed))
    return { entry, installed, status: "dev", message: DEV_SKIPPED };
  const present = installed && (await foldersPresent(ctx, installed));
  if (!release) return { entry, installed, status: present ? "unknown" : "missing" };
  const resolved = await release();
  return {
    entry,
    installed,
    latest: resolved,
    status: !present
      ? "missing"
      : installed.versionKey === resolved.versionKey
        ? "current"
        : "update",
    message: resolved.note,
  };
}
function failure(entry: Entry, state: State, error: unknown): Row {
  if (
    error instanceof WowaddonError &&
    ["ABORTED", "RECOVERY_BLOCKED", "PENDING_CORRUPT"].includes(error.code)
  )
    throw error;
  return {
    entry,
    installed: state.addons[entry.id],
    status: error instanceof WowaddonError && error.code === "UNMANAGED" ? "unmanaged" : "error",
    message: error instanceof Error ? error.message : "Addon operation failed.",
    code: error instanceof WowaddonError ? error.code : "ERROR",
  };
}
// Whether a missing addon's install would land on a folder wowaddon does not manage, as sync would
// find it, decided by the cheapest evidence that settles it: no such folder at all, a folder whose
// TOC carries the addon's project ID, then the folder list the source publishes for the addon. Only
// a folder named like the addon that none of these settle costs the download a sync dry run makes.
// A folder named unlike the addon and unknown to the source is missed.
async function blockedRow(
  ctx: Context,
  state: State,
  row: Row,
  signal?: AbortSignal,
): Promise<Row> {
  const { entry, latest: release } = row;
  const foreign = await foreignFolders(ctx, state, entry);
  if (!foreign.length || !release) return row;
  let folders = foreign.filter((item) => item.byId).map((item) => item.folder);
  if (!folders.length) {
    const known = await knownFolders(ctx, entry, signal);
    if (!known.length) {
      if (!foreign.some((item) => item.byName)) return row;
      return installAddon(ctx, state, entry, release, { dryRun: true, signal });
    }
    folders = foreign
      .filter((item) => known.includes(item.folder.toLowerCase()))
      .map((item) => item.folder);
  }
  if (await foldersFree(ctx, state, entry.id, folders)) return row;
  return { ...row, status: "dev", message: DEV_SKIPPED };
}
// The folders a source lists for an addon's package, lower-cased; empty when it lists none or the
// lookup fails. Wago lists none and its lookup needs the paid key, so it is not asked.
async function knownFolders(ctx: Context, entry: Entry, signal?: AbortSignal): Promise<string[]> {
  if (entry.kind === "wago") return [];
  try {
    return (await sourceInfo(ctx, entry.id, signal)).folders.map((name) => name.toLowerCase());
  } catch {
    checkAbort(signal);
    return [];
  }
}
// With refresh, each row's status is what sync would do: install a missing addon, update an
// outdated one, skip a dev link, stop at an unmanaged folder or leave a current one alone. Nothing
// is written but the CurseForge name cache.
export async function listRows(
  ctx: Context,
  opts: { refresh: boolean; ids?: string[]; signal?: AbortSignal },
): Promise<Row[]> {
  beginProtectionChecks(ctx);
  const state = await readState(ctx);
  const { manifest, errors } = await entries(ctx, opts.refresh, opts.signal);
  const rows: Row[] = [];
  for (const entry of await select(ctx, manifest, opts.ids, opts.signal)) {
    checkAbort(opts.signal);
    try {
      if (errors.has(entry.id)) throw errors.get(entry.id);
      const row = await statusRow(
        ctx,
        entry,
        state.addons[entry.id],
        opts.refresh ? () => latest(ctx, entry, opts.signal) : undefined,
      );
      rows.push(
        opts.refresh && row.status === "missing"
          ? await blockedRow(ctx, state, row, opts.signal)
          : row,
      );
    } catch (error) {
      rows.push(failure(entry, state, error));
    }
  }
  return rows;
}
async function syncEntry(
  ctx: Context,
  state: State,
  entry: Entry,
  opts: InstallOptions,
  release?: Release,
): Promise<Row> {
  try {
    checkAbort(opts.signal);
    if (await isProtected(ctx, entry, state.addons[entry.id])) {
      opts.onProgress?.({ id: entry.id, phase: "skipped", message: DEV_SKIPPED });
      return { entry, installed: state.addons[entry.id], status: "dev", message: DEV_SKIPPED };
    }
    opts.onProgress?.({ id: entry.id, phase: "resolving" });
    return await installAddon(
      ctx,
      state,
      entry,
      release ?? (await latest(ctx, entry, opts.signal)),
      opts,
    );
  } catch (error) {
    const row = failure(entry, state, error);
    opts.onProgress?.({ id: entry.id, phase: "failed", message: row.message });
    return row;
  }
}
export async function addAddon(
  ctx: Context,
  input: string,
  opts: {
    note?: string;
    install: boolean;
    adopt?: boolean;
    dryRun?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
  },
): Promise<Row> {
  const parsed = parseRef(input);
  return withState(ctx, opts.dryRun, async (state) => {
    checkAbort(opts.signal);
    const { manifest } = await entries(ctx, true, opts.signal);
    let note = opts.note;
    let release: Release | undefined;
    let releaseError: unknown;
    if (parsed.kind === "cf") {
      let project = await resolveCfProject(ctx, parsed.ref, opts.signal);
      if (opts.install && !/^\d+$/.test(parsed.ref)) {
        try {
          release = await resolveCurseforge(ctx, parsed.ref, opts.signal);
        } catch (error) {
          checkAbort(opts.signal);
          releaseError = error;
        }
        const refreshed = await resolveCfProject(ctx, parsed.ref, opts.signal);
        project = { ...refreshed, title: project.title ?? refreshed.title };
      }
      parsed.ref = project.id;
      note ??= project.title;
    }
    const entry: Entry = {
      ...parsed,
      id: canonicalId(parsed.kind, parsed.ref),
      ...(note ? { note } : {}),
    };
    if (manifest.some((other) => other.id === entry.id))
      throw new WowaddonError("DUPLICATE", `Addon already in manifest: ${entry.id}`);
    checkAbort(opts.signal);
    // All or nothing: the manifest gains the entry only once the add has succeeded (installed, a
    // dev link left in place, or --no-install), so a failed add can simply be rerun. A dry run takes
    // the same path and never writes. A manifest write that fails after an install leaves the
    // folders recorded in state, and rerunning the add finds them current and writes the line.
    const save = async (row: Row) => {
      if (!opts.dryRun) await writeManifest(ctx, [...manifest, entry]);
      return row;
    };
    if (!opts.install) return save(await statusRow(ctx, entry, state.addons[entry.id]));
    if (releaseError) {
      const row = failure(entry, state, releaseError);
      opts.onProgress?.({ id: entry.id, phase: "failed", message: row.message });
      return row;
    }
    const row = await syncEntry(ctx, state, entry, opts, release);
    return row.status === "current" || row.status === "dev" ? save(row) : row;
  });
}
async function findId(
  ctx: Context,
  input: string,
  manifest: Entry[],
  signal?: AbortSignal,
): Promise<string> {
  if (manifest.some((entry) => entry.id === input)) return input;
  // A bare name such as elvui names the one manifest entry with that ref, whatever its source.
  const named = manifest.filter((entry) => entry.ref === input.trim().toLowerCase());
  if (named.length === 1) return named[0].id;
  const parsed = parseRef(input);
  const exact = manifest.find((entry) => entry.kind === parsed.kind && entry.ref === parsed.ref);
  if (exact) return exact.id;
  if (parsed.kind === "cf") parsed.ref = (await resolveCfProject(ctx, parsed.ref, signal)).id;
  return canonicalId(parsed.kind, parsed.ref);
}
async function select(
  ctx: Context,
  manifest: Entry[],
  ids: string[] | undefined,
  signal?: AbortSignal,
): Promise<Entry[]> {
  if (!ids?.length) return manifest;
  const wanted = new Set<string>();
  for (const input of ids) wanted.add(await findId(ctx, input, manifest, signal));
  for (const id of wanted)
    if (!manifest.some((entry) => entry.id === id))
      throw new WowaddonError("NOT_FOUND", `Addon is not in the manifest: ${id}`);
  return manifest.filter((entry) => wanted.has(entry.id));
}
export async function syncAddons(
  ctx: Context,
  opts: {
    ids?: string[];
    adopt?: boolean;
    dryRun?: boolean;
    backup?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
  },
): Promise<{ rows: Row[]; backup?: string }> {
  return withState(ctx, opts.dryRun, async (state) => {
    checkAbort(opts.signal);
    const { manifest, errors } = await entries(ctx, true, opts.signal);
    const selected = await select(ctx, manifest, opts.ids, opts.signal);
    // One WTF snapshot before the first change; if it fails, every install fails with it.
    let backup: Promise<string | undefined> | undefined;
    const beforeChange =
      opts.backup === false || opts.dryRun
        ? undefined
        : async () => {
            backup ??= backupWtf(ctx);
            await backup;
          };
    const rows: Row[] = [];
    for (const entry of selected) {
      checkAbort(opts.signal);
      if (errors.has(entry.id)) {
        const row = failure(entry, state, errors.get(entry.id));
        opts.onProgress?.({ id: entry.id, phase: "failed", message: row.message });
        rows.push(row);
      } else rows.push(await syncEntry(ctx, state, entry, { ...opts, beforeChange }));
    }
    return { rows, backup: await backup?.catch(() => undefined) };
  });
}
// deleted says whether the addon's folders go; a dev link stays in place and is only untracked.
export interface Removal {
  entry: Entry;
  installed?: Installed;
  deleted: boolean;
}
export async function removeAddon(
  ctx: Context,
  id: string,
  opts: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<Removal> {
  return withState(ctx, opts.dryRun, async (state) => {
    checkAbort(opts.signal);
    const { manifest } = await entries(ctx, false, opts.signal);
    const [entry] = await select(ctx, manifest, [id], opts.signal);
    const installed = state.addons[entry.id];
    if (opts.dryRun)
      return {
        entry,
        installed,
        deleted: !!installed && !(await isProtected(ctx, entry, installed)),
      };
    checkAbort(opts.signal);
    const deleted = await removeInstalled(ctx, state, entry.id, opts);
    await writeManifest(
      ctx,
      manifest.filter((other) => other.id !== entry.id),
    );
    return { entry, installed, deleted };
  });
}

export type { AdoptionPlan, Query, Untracked };
// Search and browse ask every searchable source at once; a source that fails or cannot answer the
// query is reported in sources while the rest still answer.
export function findAddons(
  ctx: Context,
  query: Query,
  opts: { sources?: SourceKind[]; signal?: AbortSignal } = {},
): Promise<{ results: Listing[]; sources: SourceReport[] }> {
  return discover(ctx, query, opts);
}
export function addonInfo(ctx: Context, ref: string, signal?: AbortSignal): Promise<AddonInfo> {
  return sourceInfo(ctx, ref, signal);
}
export function listCategories(
  ctx: Context,
  signal?: AbortSignal,
): Promise<{ categories: Category[]; sources: SourceReport[] }> {
  return categories(ctx, signal);
}
// Installed folders no manifest addon owns, with the dev links and non-addon folders left out.
export async function listUntracked(ctx: Context): Promise<Untracked[]> {
  return (await untrackedFolders(ctx, await readState(ctx))).untracked;
}
// Takes over installed addons wowaddon does not manage yet: each one matched to a source is added
// to the manifest and synced with adopt, behind one WTF snapshot. A dry run only plans.
export async function adoptAddons(
  ctx: Context,
  opts: {
    wowup?: string | false;
    dryRun?: boolean;
    backup?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
  },
): Promise<{ plan: AdoptionPlan; rows: Row[]; backup?: string }> {
  const { manifest } = await entries(ctx, true, opts.signal);
  const plan = await planAdoption(ctx, manifest, opts);
  if (opts.dryRun || !plan.matches.length) return { plan, rows: [] };
  for (const match of plan.matches.filter((m) => !m.inManifest))
    await addAddon(ctx, match.entry.id, {
      note: match.entry.note,
      install: false,
      signal: opts.signal,
    });
  const { rows, backup } = await syncAddons(ctx, {
    ids: plan.matches.map((match) => match.entry.id),
    adopt: true,
    backup: opts.backup,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
  return { plan, rows, backup };
}
