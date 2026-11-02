import { backupWtf } from "./backup";
import { openContext as openConfiguredContext } from "./config";
import { checkAbort } from "./http";
import {
  beginProtectionChecks,
  foldersPresent,
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
  type Context,
  type Entry,
  type Flavor,
  type Installed,
  type Progress,
  type Release,
  type Row,
  type SourceKind,
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
    return { entry, installed, status: "dev", message: "dev link, skipped" };
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
// With refresh, each row's status is what sync would do: install a missing addon, update an
// outdated one, skip a dev link or leave a current one alone. Nothing is written but the CurseForge
// name cache.
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
      rows.push(
        await statusRow(
          ctx,
          entry,
          state.addons[entry.id],
          opts.refresh ? () => latest(ctx, entry, opts.signal) : undefined,
        ),
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
      opts.onProgress?.({ id: entry.id, phase: "skipped", message: "dev link, skipped" });
      return {
        entry,
        installed: state.addons[entry.id],
        status: "dev",
        message: "dev link, skipped",
      };
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
    if (opts.dryRun) {
      if (releaseError) return failure(entry, state, releaseError);
      try {
        return await statusRow(
          ctx,
          entry,
          state.addons[entry.id],
          opts.install ? async () => release ?? latest(ctx, entry, opts.signal) : undefined,
        );
      } catch (error) {
        return failure(entry, state, error);
      }
    }
    await writeManifest(ctx, [...manifest, entry]);
    if (!opts.install)
      return {
        entry,
        installed: state.addons[entry.id],
        status: state.addons[entry.id] ? "unknown" : "missing",
      };
    if (releaseError) {
      const row = failure(entry, state, releaseError);
      opts.onProgress?.({ id: entry.id, phase: "failed", message: row.message });
      return row;
    }
    return syncEntry(ctx, state, entry, opts, release);
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
    backup?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
  },
): Promise<{ rows: Row[]; backup?: string }> {
  return withInstallLock(ctx, async (state) => {
    checkAbort(opts.signal);
    const { manifest, errors } = await entries(ctx, true, opts.signal);
    const selected = await select(ctx, manifest, opts.ids, opts.signal);
    // One WTF snapshot before the first change; if it fails, every install fails with it.
    let backup: Promise<string | undefined> | undefined;
    const beforeChange =
      opts.backup === false
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
