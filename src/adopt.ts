import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { addonInfo, discover } from "./discover";
import { checkAbort } from "./http";
import { protectedFolder } from "./install";
import { canonicalId } from "./refs";
import { readState, type State } from "./state";
import { tocMatchesFolder } from "./toc";
import { type AddonInfo, type Context, type Entry, type SourceKind, WowaddonError } from "./types";
import { readWowup, type WowupData, wowupRef } from "./wowup";

// An AddOns folder no manifest addon owns: what check reports and adopt tries to match.
export interface Untracked {
  folder: string;
  title?: string;
  toc: string;
}
export type MatchedBy = "manifest" | "wowup" | "toc" | "title";
export interface Match {
  entry: Entry;
  folders: string[];
  matchedBy: MatchedBy;
  inManifest: boolean;
  // Other manifest addons, not yet installed, that name one of these folders.
  conflicts: string[];
}
export interface Unmatched {
  folder: string;
  title?: string;
  reason: string;
}
export interface AdoptionPlan {
  wowup: { path: string; installation: string } | null;
  matches: Match[];
  unmatched: Unmatched[];
  skipped: { folder: string; reason: string }[];
}

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
// A TOC title can carry colour codes (|cff00ff00Name|r) and texture escapes.
const plainTitle = (title: string) =>
  title
    .replace(/\|c[0-9a-f]{8}/gi, "")
    .replace(/\|r/gi, "")
    .replace(/\|T[^|]*\|t/gi, "")
    .trim();
const tocField = (toc: string, field: string) =>
  new RegExp(`^\\s*##\\s*${field}\\s*:\\s*(.+?)\\s*$`, "im").exec(toc)?.[1];

export async function untrackedFolders(
  ctx: Context,
  state: State,
): Promise<{ untracked: Untracked[]; skipped: { folder: string; reason: string }[] }> {
  const taken = new Set(
    Object.values(state.addons).flatMap((installed) =>
      installed.folders.map((f) => f.toLowerCase()),
    ),
  );
  const untracked: Untracked[] = [];
  const skipped: { folder: string; reason: string }[] = [];
  for (const item of await readdir(ctx.addonsDir, { withFileTypes: true })) {
    if (taken.has(item.name.toLowerCase())) continue;
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    if (/^blizzard_/i.test(item.name)) continue;
    if (await protectedFolder(ctx, item.name).catch(() => true)) {
      skipped.push({ folder: item.name, reason: "dev link, never touched" });
      continue;
    }
    const dir = join(ctx.addonsDir, item.name);
    const file = (await readdir(dir).catch(() => [])).find((name) =>
      tocMatchesFolder(name, item.name),
    );
    if (!file) {
      skipped.push({ folder: item.name, reason: "no TOC named after the folder, so not an addon" });
      continue;
    }
    const toc = await readFile(join(dir, file), "utf8");
    const title = tocField(toc, "Title");
    untracked.push({ folder: item.name, toc, ...(title ? { title: plainTitle(title) } : {}) });
  }
  // Shorter names first, so AtlasLootClassic is matched before AtlasLootClassic_Data joins it.
  untracked.sort((a, b) => a.folder.length - b.folder.length || a.folder.localeCompare(b.folder));
  return { untracked, skipped };
}

const tukuiIds: Record<string, string> = { "-1": "tukui", "-2": "elvui" };
// A packager writes 0 as a placeholder before the addon has a store project, so it is not an ID:
// resolving it would ask CurseForge or WoWInterface for project 0.
const isProjectId = (value: string) => /^\d+$/.test(value) && Number(value) > 0;
function tocRefs(toc: string): { kind: SourceKind; ref: string }[] {
  const refs: { kind: SourceKind; ref: string }[] = [];
  const cf = tocField(toc, "X-Curse-Project-ID");
  if (cf && isProjectId(cf)) refs.push({ kind: "cf", ref: cf });
  const wowi = tocField(toc, "X-WoWI-ID");
  if (wowi && isProjectId(wowi)) refs.push({ kind: "wowi", ref: wowi });
  const tukui = tocField(toc, "X-Tukui-ProjectID");
  if (tukui && tukuiIds[tukui]) refs.push({ kind: "tukui", ref: tukuiIds[tukui] });
  return refs;
}

// Finds a source for every untracked folder, in this order: WowUp's own record of the addon, the
// project IDs the TOC carries, then a search by the TOC title that is kept only when the found
// addon's package has a folder of this name. A manifest line not installed yet that names the
// folder wins over a new line, so adopting never duplicates an addon. Nothing is written.
export async function planAdoption(
  ctx: Context,
  manifest: Entry[],
  opts: { wowup?: string | false; signal?: AbortSignal } = {},
): Promise<AdoptionPlan> {
  const state = await readState(ctx);
  const { untracked, skipped } = await untrackedFolders(ctx, state);
  const wowup: WowupData | undefined =
    opts.wowup === false ? undefined : await readWowup(ctx, opts.wowup || undefined);
  const present = new Map(untracked.map((item) => [item.folder.toLowerCase(), item.folder]));
  const claimed = new Set<string>();
  const matches: Match[] = [];
  const unmatched: Unmatched[] = [];
  const info = async (ref: string): Promise<AddonInfo | undefined> => {
    try {
      return await addonInfo(ctx, ref, opts.signal);
    } catch (error) {
      checkAbort(opts.signal);
      if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
      return undefined;
    }
  };
  const hasFolder = (found: AddonInfo | undefined, folder: string) =>
    !!found?.folders.some((name) => name.toLowerCase() === folder.toLowerCase());
  for (const item of untracked) {
    checkAbort(opts.signal);
    if (claimed.has(item.folder.toLowerCase())) continue;
    let candidate: { kind: SourceKind; ref: string; matchedBy: MatchedBy } | undefined;
    let found: AddonInfo | undefined;
    let reason = "no WowUp record, TOC project ID or same-named addon with this folder";
    const record = wowup?.addons.find((addon) =>
      addon.folders.some((name) => name.toLowerCase() === item.folder.toLowerCase()),
    );
    if (record) {
      const ref = await wowupRef(record, opts.signal);
      if ("reason" in ref) reason = ref.reason;
      else candidate = { ...ref, matchedBy: "wowup" };
    }
    if (!candidate) {
      const [ref] = tocRefs(item.toc);
      if (ref) candidate = { ...ref, matchedBy: "toc" };
    }
    if (candidate) found = await info(`${candidate.kind}:${candidate.ref}`);
    else if (item.title) {
      const { results } = await discover(
        ctx,
        { text: item.title, order: "relevance", limit: 10, page: 1, allFlavors: false },
        { sources: ["cf", "gh", "wowi", "tukui"], signal: opts.signal },
      );
      const exact = results.filter((listing) => key(listing.name) === key(item.title ?? ""));
      for (const listing of exact.slice(0, 3)) {
        const details = await info(listing.ref);
        if (hasFolder(details, item.folder)) {
          const [kind, ref] = [listing.kind, listing.ref.slice(listing.kind.length + 1)];
          candidate = { kind, ref, matchedBy: "title" };
          found = details;
          break;
        }
      }
    }
    // Manifest lines not installed yet that name this folder, by repo or slug name or TOC ID.
    const ids = new Set(tocRefs(item.toc).map((ref) => `${ref.kind}:${ref.ref}`));
    const claims = manifest.filter((entry) => {
      if (state.addons[entry.id]) return false;
      const name = entry.kind === "gh" ? entry.ref.split("/")[1] : entry.ref;
      return key(name ?? "") === key(item.folder) || ids.has(entry.id);
    });
    let id = candidate && canonicalId(candidate.kind, candidate.ref);
    if (claims.length && !claims.some((entry) => entry.id === id)) {
      const [entry] = claims;
      candidate = { kind: entry.kind, ref: entry.ref, matchedBy: "manifest" };
      id = entry.id;
      found = await info(id);
    }
    if (!candidate || !id) {
      unmatched.push({ folder: item.folder, ...(item.title ? { title: item.title } : {}), reason });
      continue;
    }
    const folders = [
      ...new Set(
        [item.folder, ...(found?.folders ?? []), ...(record?.folders ?? [])]
          .map((name) => present.get(name.toLowerCase()))
          .filter((name): name is string => !!name && !claimed.has(name.toLowerCase())),
      ),
    ];
    for (const folder of folders) claimed.add(folder.toLowerCase());
    const conflicts = claims.filter((entry) => entry.id !== id).map((entry) => entry.id);
    matches.push({
      entry: {
        id,
        kind: candidate.kind,
        ref: candidate.ref,
        ...(found?.name || record?.name ? { note: found?.name ?? record?.name } : {}),
      },
      folders,
      matchedBy: candidate.matchedBy,
      inManifest: manifest.some((entry) => entry.id === id),
      conflicts,
    });
  }
  return {
    wowup: wowup ? { path: wowup.path, installation: wowup.installation } : null,
    matches,
    unmatched,
    skipped,
  };
}
