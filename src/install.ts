import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Archive, readArchive } from "./archive";
import { isMissing } from "./config";
import { checkAbort, getCredentials, requestBytes } from "./http";
import { acquireLock, releaseLock } from "./lock";
import { downloadCurseforge } from "./sources/curseforge";
import { atomicWrite, readState, type State, safeFolder, validateState, writeState } from "./state";
import {
  devBuildTag,
  releaseSupersedesDevBuild,
  releaseVersionAtLeast,
  tocMatchesFolder,
  tocVersion,
} from "./toc";
import {
  type Context,
  type Entry,
  type Installed,
  type Progress,
  type Release,
  type Row,
  WowaddonError,
} from "./types";

export const pendingPath = (ctx: Context): string =>
  join(ctx.configDir, "state", `${ctx.flavor}.pending.json`);
async function info(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
async function assertRoot(ctx: Context): Promise<void> {
  const root = await info(ctx.addonsDir);
  if (
    !root?.isDirectory() ||
    root.isSymbolicLink() ||
    (await realpath(ctx.addonsDir)) !== resolve(ctx.addonsDir)
  )
    throw new WowaddonError(
      "DESTINATION_CHANGED",
      "The AddOns directory changed; reopen the context before installing.",
    );
}
async function containsGit(path: string): Promise<boolean> {
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (item.name.toLowerCase() === ".git") return true;
    if (item.isDirectory() && (await containsGit(join(path, item.name)))) return true;
  }
  return false;
}
interface FolderProtection {
  symlink: boolean;
  other: boolean;
}
async function folderProtection(ctx: Context, folder: string): Promise<FolderProtection> {
  if (!safeFolder(folder))
    throw new WowaddonError("STATE_CORRUPT", "Unsafe addon folder in state.");
  const target = join(ctx.addonsDir, folder);
  const targetInfo = await info(target);
  const symlink = !!targetInfo?.isSymbolicLink();
  const git = !!targetInfo?.isDirectory() && (await containsGit(target));
  let ancestor = ancestorProtection.get(ctx);
  if (!ancestor) {
    ancestor = insideWorktree(ctx);
    ancestorProtection.set(ctx, ancestor);
  }
  return { symlink, other: git || (await ancestor) };
}
export async function protectedFolder(ctx: Context, folder: string): Promise<boolean> {
  const protection = await folderProtection(ctx, folder);
  return protection.symlink || protection.other;
}
const ancestorProtection = new WeakMap<Context, Promise<boolean>>();
export function beginProtectionChecks(ctx: Context): void {
  ancestorProtection.delete(ctx);
}
async function insideWorktree(ctx: Context): Promise<boolean> {
  for (let cursor = ctx.addonsDir; ; cursor = dirname(cursor)) {
    if (await info(join(cursor, ".git"))) return true;
    if (dirname(cursor) === cursor) break;
  }
  return false;
}
const projectKeys: Partial<Record<Entry["kind"], string>> = {
  cf: "X-Curse-Project-ID",
  wowi: "X-WoWI-ID",
  wago: "X-Wago-ID",
};
const projectIdPattern = (entry: Entry) => {
  const key = projectKeys[entry.kind];
  // 0 is a packager placeholder, not a project: it must never claim a folder by TOC id.
  if (key && /^0+$/.test(entry.ref)) return undefined;
  return key ? new RegExp(`^\\s*##\\s*${key}\\s*:\\s*${entry.ref}\\s*$`, "im") : undefined;
};
async function tocOf(ctx: Context, folder: string): Promise<string | undefined> {
  const dir = join(ctx.addonsDir, folder);
  const file = (await readdir(dir).catch(() => [])).find((name) => tocMatchesFolder(name, folder));
  return file && readFile(join(dir, file), "utf8").catch(() => undefined);
}
const folderKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
// The folder name a source's own ref implies: QuestieTrace for gh questie/questietrace.
function impliedFolder(entry: Entry): string | undefined {
  if (entry.kind === "gh") return folderKey(entry.ref.slice(entry.ref.indexOf("/") + 1));
  if (entry.kind === "tukui" || entry.kind === "wago") return folderKey(entry.ref);
  return undefined;
}
// A dev folder (symlink or checkout) named after this addon, or whose TOC carries its own project
// ID: found before the first install, when state doesn't know the addon's folders yet.
async function devFolderFor(ctx: Context, entry: Entry): Promise<string | undefined> {
  const name = impliedFolder(entry);
  const id = projectIdPattern(entry);
  for (const item of await readdir(ctx.addonsDir, { withFileTypes: true })) {
    if (!safeFolder(item.name) || !(await protectedFolder(ctx, item.name))) continue;
    if (folderKey(item.name) === name) return item.name;
    if (id?.test((await tocOf(ctx, item.name)) ?? "")) return item.name;
  }
  return undefined;
}
// An AddOns folder no addon in state owns, with what is known without a download about whether
// installing entry would land on it: its TOC carries entry's project ID (byId), or its name is the
// one entry's ref or note implies (byName, only a guess).
export interface ForeignFolder {
  folder: string;
  byId: boolean;
  byName: boolean;
}
export async function foreignFolders(
  ctx: Context,
  state: State,
  entry: Entry,
): Promise<ForeignFolder[]> {
  const owned = new Set(
    Object.values(state.addons).flatMap((installed) =>
      installed.folders.map((name) => name.toLowerCase()),
    ),
  );
  const names = new Set([impliedFolder(entry), entry.note && folderKey(entry.note)]);
  const id = projectIdPattern(entry);
  const found: ForeignFolder[] = [];
  for (const item of await readdir(ctx.addonsDir, { withFileTypes: true })) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    if (!safeFolder(item.name) || /^blizzard_/i.test(item.name)) continue;
    if (owned.has(item.name.toLowerCase())) continue;
    found.push({
      folder: item.name,
      byId: !!id?.test((await tocOf(ctx, item.name)) ?? ""),
      byName: names.has(folderKey(item.name)),
    });
  }
  return found;
}
export interface DevLink {
  folder: string;
  tag: string;
}
export interface Protection {
  protected: boolean;
  // A symlinked dev build whose TOC names the release it was built from.
  dev?: DevLink;
  // Protected for a reason that cannot expire, such as a git checkout or worktree.
  blocked: boolean;
}
async function devLinkIn(ctx: Context, folder: string): Promise<DevLink | undefined> {
  const target = await info(join(ctx.addonsDir, folder));
  if (!target?.isSymbolicLink()) return undefined;
  const tag = devBuildTag((await tocOf(ctx, folder)) ?? "");
  return tag ? { folder, tag } : undefined;
}
export async function protection(
  ctx: Context,
  entry: Entry,
  installed?: Installed,
): Promise<Protection> {
  if (!installed) {
    const folder = await devFolderFor(ctx, entry);
    if (!folder) return { protected: false, blocked: false };
    const state = await folderProtection(ctx, folder);
    const dev = state.symlink ? await devLinkIn(ctx, folder) : undefined;
    return {
      protected: state.symlink || state.other,
      blocked: state.other || !dev,
      ...(dev ? { dev } : {}),
    };
  }
  let guarded = false;
  let blocked = false;
  let dev: DevLink | undefined;
  for (const folder of installed.folders) {
    const state = await folderProtection(ctx, folder);
    if (!state.symlink && !state.other) continue;
    guarded = true;
    if (state.other) blocked = true;
    if (state.symlink) {
      const found = await devLinkIn(ctx, folder);
      if (found) dev ??= found;
      else blocked = true;
    }
  }
  return { protected: guarded, blocked, ...(dev ? { dev } : {}) };
}
export async function isProtected(
  ctx: Context,
  entry: Entry,
  installed?: Installed,
): Promise<boolean> {
  return (await protection(ctx, entry, installed)).protected;
}
export async function foldersPresent(ctx: Context, installed: Installed): Promise<boolean> {
  for (const folder of installed.folders)
    if (!(await info(join(ctx.addonsDir, folder)))?.isDirectory()) return false;
  return true;
}
export async function withInstallLock<T>(
  ctx: Context,
  work: (state: State) => Promise<T>,
): Promise<T> {
  const token = await acquireLock(ctx);
  try {
    beginProtectionChecks(ctx);
    await assertRoot(ctx);
    await readState(ctx);
    await recoverPending(ctx);
    return await work(await readState(ctx));
  } finally {
    await releaseLock(ctx, token);
  }
}
interface Operation {
  folder: string;
  hadOld: boolean;
  putNew: boolean;
}
interface Pending {
  schema: 1;
  addonsDir: string;
  txDir: string;
  before: State;
  operations: Operation[];
}
async function readPending(ctx: Context): Promise<Pending | undefined> {
  let text: string;
  try {
    text = await readFile(pendingPath(ctx), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const data = JSON.parse(text) as Pending;
    if (
      data.schema !== 1 ||
      data.addonsDir !== ctx.addonsDir ||
      typeof data.txDir !== "string" ||
      dirname(data.txDir) !== dirname(ctx.addonsDir) ||
      !/^\.wowaddon-[a-f0-9-]+$/.test(data.txDir.slice(dirname(data.txDir).length + 1)) ||
      !Array.isArray(data.operations)
    )
      throw new Error();
    validateState(data.before, ctx);
    const seen = new Set<string>();
    for (const operation of data.operations) {
      if (
        !safeFolder(operation.folder) ||
        typeof operation.hadOld !== "boolean" ||
        typeof operation.putNew !== "boolean" ||
        seen.has(operation.folder.toLowerCase())
      )
        throw new Error();
      seen.add(operation.folder.toLowerCase());
    }
    for (const path of [data.txDir, join(data.txDir, "new"), join(data.txDir, "old")]) {
      const entry = await info(path);
      if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error();
    }
    return data;
  } catch {
    throw new WowaddonError(
      "PENDING_CORRUPT",
      `Cannot safely recover pending transaction: ${pendingPath(ctx)}. Preserve its backups and repair the record first.`,
    );
  }
}
async function rollback(ctx: Context, pending: Pending): Promise<void> {
  for (const operation of [...pending.operations].reverse()) {
    const target = join(ctx.addonsDir, operation.folder);
    const backup = join(pending.txDir, "old", operation.folder);
    const staged = join(pending.txDir, "new", operation.folder);
    const hasBackup = !!(await info(backup));
    const placedNew = !operation.hadOld && operation.putNew && !(await info(staged));
    if (!hasBackup && !placedNew) {
      if (operation.hadOld && !(await info(target)))
        throw new WowaddonError(
          "RECOVERY_BLOCKED",
          `Missing original and backup for ${operation.folder}; preserve ${pending.txDir}.`,
        );
      // Nothing of this operation was moved, so there is nothing to undo and the folder is left
      // alone, even if it has become protected since.
      continue;
    }
    if (await protectedFolder(ctx, operation.folder))
      throw new WowaddonError(
        "RECOVERY_BLOCKED",
        `Cannot recover protected folder ${operation.folder}; backups remain in ${pending.txDir}.`,
      );
    await rm(target, { recursive: true, force: true });
    if (hasBackup) await rename(backup, target);
  }
  await writeState(ctx, pending.before);
  await rm(pendingPath(ctx));
  await rm(pending.txDir, { recursive: true, force: true });
}
export async function recoverPending(ctx: Context): Promise<void> {
  const pending = await readPending(ctx);
  if (!pending) return;
  await rollback(ctx, pending);
  ctx.notices.push("Recovered an interrupted addon installation from its backups.");
}
export const DEV_SKIPPED =
  "dev link, skipped: to install a release here, remove the symlink or checkout, then run sync";
export const devWaiting = (tag: string) => `dev build of ${tag}, waiting for a newer release`;
export const devReplaced = (tag: string, version: string) =>
  `dev build of ${tag} replaced by ${version}`;
export interface InstallOptions {
  adopt?: boolean;
  // Stops once the download is read and the folders are checked: the row says what a real run would do.
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  // Runs after the download is read, just before the AddOns folder changes.
  beforeChange?: () => Promise<void>;
  rename?: typeof rename;
  // An expired dev link this install may replace; its target is never touched.
  replaceDev?: DevLink;
  // A dependency's download, already read, so it is fetched only once.
  archive?: Archive;
}
// Reads a release exactly as an install does: the bytes, then the addon folders and files in them.
export async function readRelease(
  ctx: Context,
  entry: Entry,
  release: Release,
  signal?: AbortSignal,
): Promise<Archive> {
  const bytes =
    entry.kind === "cf"
      ? await downloadCurseforge(ctx, release, signal)
      : await requestBytes(release.url, {
          credentials: await getCredentials(ctx),
          signal,
        });
  return readArchive(bytes, {
    flavor: ctx.flavor,
    source: release.archive === "source",
    signal,
  });
}
async function replacement(ctx: Context, replaceDev: DevLink | undefined, folder: string) {
  if (replaceDev?.folder !== folder) return false;
  return (await devLinkIn(ctx, folder))?.tag === replaceDev.tag;
}
function otherOwners(state: State, id: string, folder: string): string[] {
  const name = folder.toLowerCase();
  return Object.entries(state.addons)
    .filter(
      ([owner, installed]) =>
        owner !== id && installed.folders.some((listed) => listed.toLowerCase() === name),
    )
    .map(([owner]) => owner);
}
function archiveTocVersion(archive: Archive, folder: string): string | undefined {
  const name = folder.toLowerCase();
  for (const [path, data] of archive.files) {
    const [top, file, ...rest] = path.split("/");
    if (rest.length === 0 && top.toLowerCase() === name && tocMatchesFolder(file, top))
      return tocVersion(new TextDecoder().decode(data));
  }
  return undefined;
}
// A shared folder is replaced only when the incoming copy is at least as new as the one on disk.
async function sharedCopyWins(
  ctx: Context,
  archive: Archive,
  folder: string,
  shared: boolean,
): Promise<boolean> {
  if (!shared) return true;
  const incoming = archiveTocVersion(archive, folder);
  const current = tocVersion((await tocOf(ctx, folder)) ?? "");
  if (!incoming || !current) return true;
  return releaseVersionAtLeast(incoming, current);
}
async function preflight(
  ctx: Context,
  state: State,
  id: string,
  folders: string[],
  incoming: string[],
  adopt: boolean,
  replaceDev?: DevLink,
): Promise<boolean> {
  await assertRoot(ctx);
  const incomingSet = new Set(incoming.map((folder) => folder.toLowerCase()));
  for (const folder of folders) {
    if (!(await replacement(ctx, replaceDev, folder)) && (await protectedFolder(ctx, folder))) {
      // A package may carry a shared dependency whose independently managed dev link must stay
      // untouched. It is safe to leave that folder in place when its TOC identifies another addon;
      // the requested addon folder is still protected by the normal guard.
      const toc = await tocOf(ctx, folder);
      const foreignCurseId = toc?.match(/^\s*##\s*X-Curse-Project-ID\s*:\s*(\d+)\s*$/im)?.[1];
      if (!foreignCurseId || id === `cf:${foreignCurseId}`) return false;
    }
  }
  const existing = new Map(
    (await readdir(ctx.addonsDir)).map((folder) => [folder.toLowerCase(), folder]),
  );
  for (const folder of folders) {
    const ships = incomingSet.has(folder.toLowerCase());
    // A folder another addon owns is shared when this archive ships it too; no write is planned
    // when it does not, so the other owner keeps it.
    const shared = ships && otherOwners(state, id, folder).length > 0;
    const actual = existing.get(folder.toLowerCase());
    if (actual && actual !== folder)
      throw new WowaddonError(
        "FOLDER_COLLISION",
        `${folder} collides with existing folder ${actual}.`,
      );
    const target = await info(join(ctx.addonsDir, folder));
    const replace = await replacement(ctx, replaceDev, folder);
    const protectedToc =
      target && (await protectedFolder(ctx, folder)) ? await tocOf(ctx, folder) : undefined;
    const foreignProtected =
      !!protectedToc &&
      !!protectedToc.match(/^\s*##\s*X-Curse-Project-ID\s*:\s*(\d+)\s*$/im)?.[1] &&
      id !== `cf:${protectedToc.match(/^\s*##\s*X-Curse-Project-ID\s*:\s*(\d+)\s*$/im)?.[1]}`;
    if (target && !replace && !foreignProtected && !target.isDirectory())
      throw new WowaddonError("FOLDER_COLLISION", `${folder} is not an addon directory.`);
    if (
      target &&
      !replace &&
      !foreignProtected &&
      !state.addons[id]?.folders.includes(folder) &&
      !shared &&
      !adopt
    )
      throw new WowaddonError(
        "UNMANAGED",
        `${folder} is already installed outside wowaddon. Use --adopt to take it over.`,
      );
  }
  return true;
}
const installFolders = (state: State, id: string, folders: string[]) => [
  ...new Set([...(state.addons[id]?.folders ?? []), ...folders]),
];
// What sync would say about installing id into these folders, short of the download: false for a
// dev link, an UNMANAGED or other folder error thrown, true when nothing is in the way.
export const foldersFree = (ctx: Context, state: State, id: string, folders: string[]) =>
  preflight(ctx, state, id, installFolders(state, id, folders), folders, false);
async function transact(
  ctx: Context,
  state: State,
  id: string,
  archive: Archive,
  installed: Installed | undefined,
  opts: InstallOptions,
): Promise<boolean> {
  if (await info(pendingPath(ctx)))
    throw new WowaddonError(
      "RECOVERY_BLOCKED",
      "An interrupted transaction still needs recovery; its backups have been preserved.",
    );
  const folders = installFolders(state, id, archive.folders);
  if (!(await preflight(ctx, state, id, folders, archive.folders, !!opts.adopt, opts.replaceDev)))
    return false;
  checkAbort(opts.signal);
  const txDir = join(dirname(ctx.addonsDir), `.wowaddon-${crypto.randomUUID()}`);
  await mkdir(txDir, { mode: 0o700 });
  let recorded = false;
  try {
    await mkdir(join(txDir, "new"));
    await mkdir(join(txDir, "old"));
    for (const [path, bytes] of archive.files) {
      checkAbort(opts.signal);
      const destination = join(txDir, "new", path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o644 });
    }
    if (!(await preflight(ctx, state, id, folders, archive.folders, !!opts.adopt, opts.replaceDev)))
      return false;
    const pending: Pending = {
      schema: 1,
      addonsDir: ctx.addonsDir,
      txDir,
      before: structuredClone(state),
      operations: [],
    };
    const incoming = new Set(archive.folders.map((folder) => folder.toLowerCase()));
    for (const folder of folders) {
      const ships = incoming.has(folder.toLowerCase());
      const shared = otherOwners(state, id, folder).length > 0;
      // Another addon still ships a folder this one no longer does: keep the copy on disk.
      if (!ships && shared) continue;
      // A shared folder stays at the newest TOC version, so an older incoming copy is not written.
      if (!(await sharedCopyWins(ctx, archive, folder, shared))) continue;
      pending.operations.push({
        folder,
        hadOld: !!(await info(join(ctx.addonsDir, folder))),
        putNew: ships,
      });
    }
    checkAbort(opts.signal);
    await atomicWrite(pendingPath(ctx), `${JSON.stringify(pending, null, 2)}\n`);
    recorded = true;
    try {
      for (const operation of pending.operations) {
        checkAbort(opts.signal);
        const incoming = operation.putNew ? [operation.folder] : [];
        if (
          !(await preflight(
            ctx,
            state,
            id,
            [operation.folder],
            incoming,
            !!opts.adopt,
            opts.replaceDev,
          ))
        )
          throw new WowaddonError("DEV_PROTECTED", DEV_SKIPPED);
        if (operation.hadOld)
          await (opts.rename ?? rename)(
            join(ctx.addonsDir, operation.folder),
            join(txDir, "old", operation.folder),
          );
        if (operation.putNew)
          await (opts.rename ?? rename)(
            join(txDir, "new", operation.folder),
            join(ctx.addonsDir, operation.folder),
          );
      }
      const next = structuredClone(state);
      if (installed) next.addons[id] = installed;
      else delete next.addons[id];
      await writeState(ctx, next);
      await rm(pendingPath(ctx));
      recorded = false;
      state.addons = next.addons;
    } catch (error) {
      try {
        await rollback(ctx, pending);
      } catch (recoveryError) {
        throw new WowaddonError(
          "RECOVERY_BLOCKED",
          `Rollback could not finish; backups remain in ${txDir}. ${recoveryError instanceof Error ? recoveryError.message : "Recovery failed."}`,
        );
      }
      recorded = false;
      if ((error as NodeJS.ErrnoException).code === "EXDEV")
        throw new WowaddonError(
          "INSTALL_FILESYSTEM",
          "Install staging and AddOns are on different filesystems (EXDEV); no changes were kept.",
        );
      throw error;
    }
    return true;
  } finally {
    if (!recorded) await rm(txDir, { recursive: true, force: true });
  }
}
export async function installAddon(
  ctx: Context,
  state: State,
  entry: Entry,
  release: Release,
  opts: InstallOptions = {},
): Promise<Row> {
  const installed = state.addons[entry.id];
  const progress = (phase: Progress["phase"], message?: string) =>
    opts.onProgress?.({ id: entry.id, phase, message });
  checkAbort(opts.signal);
  const guard = await protection(ctx, entry, installed);
  const dev = guard.dev && !guard.blocked ? guard.dev : undefined;
  const replace = dev && releaseSupersedesDevBuild(release.version, dev.tag) ? dev : undefined;
  const skipDev = (): Row => {
    const message = dev ? devWaiting(dev.tag) : DEV_SKIPPED;
    progress("skipped", message);
    return {
      entry,
      installed,
      latest: release,
      status: "dev",
      message,
      ...(dev ? { devTag: dev.tag } : {}),
    };
  };
  if (guard.protected && !replace) return skipDev();
  const present = !!installed && (await foldersPresent(ctx, installed));
  if (present && !replace && installed?.versionKey === release.versionKey) {
    progress("skipped", "up to date");
    return { entry, installed, latest: release, status: "current", message: "up to date" };
  }
  if (!opts.archive) progress("downloading");
  const archive = opts.archive ?? (await readRelease(ctx, entry, release, opts.signal));
  if (opts.dryRun) {
    const folders = installFolders(state, entry.id, archive.folders);
    if (!(await preflight(ctx, state, entry.id, folders, archive.folders, !!opts.adopt, replace)))
      return skipDev();
    return {
      entry,
      installed,
      latest: release,
      status: replace || present ? "update" : "missing",
      message: replace ? devReplaced(replace.tag, release.version) : release.note,
      ...(replace ? { devTag: replace.tag } : {}),
    };
  }
  await opts.beforeChange?.();
  progress("installing");
  const next: Installed = {
    version: release.version,
    versionKey: release.versionKey,
    folders: archive.folders,
    installedAt: new Date().toISOString(),
  };
  if (!(await transact(ctx, state, entry.id, archive, next, { ...opts, replaceDev: replace })))
    return skipDev();
  const message = replace ? devReplaced(replace.tag, release.version) : release.note;
  progress("done", message);
  return {
    entry,
    installed: next,
    latest: release,
    status: replace ? "updated" : "current",
    message,
    ...(replace ? { devTag: replace.tag } : {}),
  };
}
export async function removeInstalled(
  ctx: Context,
  state: State,
  id: string,
  opts: InstallOptions = {},
): Promise<boolean> {
  if (!state.addons[id]) return false;
  if (await transact(ctx, state, id, { folders: [], files: new Map() }, undefined, opts))
    return true;
  // A dev-protected folder is never touched: stop tracking it and leave the folder as it is.
  checkAbort(opts.signal);
  const next = structuredClone(state);
  delete next.addons[id];
  await writeState(ctx, next);
  state.addons = next.addons;
  return false;
}
