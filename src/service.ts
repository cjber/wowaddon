import { openContext as openConfiguredContext } from "./config";
import { checkAbort } from "./http";
import {
  beginProtectionChecks,
  foldersPresent,
  installAddon,
  isProtected,
  removeInstalled,
  withInstallLock,
} from "./install";
import { readManifest, writeManifest } from "./manifest";
import { canonicalId, parseRef as parseAddonRef } from "./refs";
import { cachedCfId, resolveCfProject, resolveCurseforge } from "./sources/curseforge";
import { resolveGithub } from "./sources/github";
import { resolveWowinterface } from "./sources/wowinterface";
import { readState, type State } from "./state";
import {
  type Context,
  type Entry,
  type Flavor,
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

type Options = { adopt?: boolean; signal?: AbortSignal; onProgress?: (progress: Progress) => void };
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
async function latest(ctx: Context, entry: Entry, signal?: AbortSignal): Promise<Release> {
  checkAbort(signal);
  if (entry.kind === "gh") return resolveGithub(ctx, entry.ref, signal);
  if (entry.kind === "cf") return resolveCurseforge(ctx, entry.ref, signal);
  return resolveWowinterface(ctx, entry.ref, signal);
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
  };
}
export async function listRows(
  ctx: Context,
  opts: { refresh: boolean; signal?: AbortSignal },
): Promise<Row[]> {
  beginProtectionChecks(ctx);
  const state = await readState(ctx);
  const { manifest, errors } = await entries(ctx, opts.refresh, opts.signal);
  const rows: Row[] = [];
  for (const entry of manifest) {
    checkAbort(opts.signal);
    const installed = state.addons[entry.id];
    try {
      if (errors.has(entry.id)) throw errors.get(entry.id);
      if (await isProtected(ctx, entry, installed)) {
        rows.push({ entry, installed, status: "dev", message: "dev link, skipped" });
        continue;
      }
      const present = installed && (await foldersPresent(ctx, installed));
      if (!opts.refresh) {
        rows.push({ entry, installed, status: present ? "unknown" : "missing" });
        continue;
      }
      const release = await latest(ctx, entry, opts.signal);
      rows.push({
        entry,
        installed,
        latest: release,
        status: !present
          ? "missing"
          : installed.versionKey === release.versionKey
            ? "current"
            : "update",
        message: release.note,
      });
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
  opts: Options,
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
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
  },
): Promise<Row> {
  const parsed = parseRef(input);
  return withInstallLock(ctx, async (state) => {
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
  const parsed = parseRef(input);
  const exact = manifest.find((entry) => entry.kind === parsed.kind && entry.ref === parsed.ref);
  if (exact) return exact.id;
  if (parsed.kind === "cf") parsed.ref = (await resolveCfProject(ctx, parsed.ref, signal)).id;
  return canonicalId(parsed.kind, parsed.ref);
}
export async function syncAddons(
  ctx: Context,
  opts: {
    ids?: string[];
    adopt?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
  },
): Promise<Row[]> {
  return withInstallLock(ctx, async (state) => {
    checkAbort(opts.signal);
    const { manifest, errors } = await entries(ctx, true, opts.signal);
    let selected = manifest;
    if (opts.ids?.length) {
      const wanted = new Set<string>();
      for (const input of opts.ids) wanted.add(await findId(ctx, input, manifest, opts.signal));
      for (const id of wanted)
        if (!manifest.some((entry) => entry.id === id))
          throw new WowaddonError("NOT_FOUND", `Addon is not in the manifest: ${id}`);
      selected = manifest.filter((entry) => wanted.has(entry.id));
    }
    const rows: Row[] = [];
    for (const entry of selected) {
      checkAbort(opts.signal);
      if (errors.has(entry.id)) {
        const row = failure(entry, state, errors.get(entry.id));
        opts.onProgress?.({ id: entry.id, phase: "failed", message: row.message });
        rows.push(row);
      } else rows.push(await syncEntry(ctx, state, entry, opts));
    }
    return rows;
  });
}
export async function removeAddon(
  ctx: Context,
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  return withInstallLock(ctx, async (state) => {
    checkAbort(opts.signal);
    const { manifest } = await entries(ctx, false, opts.signal);
    const canonical = await findId(ctx, id, manifest, opts.signal);
    if (!manifest.some((entry) => entry.id === canonical))
      throw new WowaddonError("NOT_FOUND", `Addon is not in the manifest: ${canonical}`);
    checkAbort(opts.signal);
    await removeInstalled(ctx, state, canonical, opts);
    await writeManifest(
      ctx,
      manifest.filter((entry) => entry.id !== canonical),
    );
  });
}
