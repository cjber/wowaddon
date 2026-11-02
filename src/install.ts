import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Archive, readArchive } from "./archive";
import { isMissing } from "./config";
import { checkAbort, getCredentials, requestBytes } from "./http";
import { acquireLock, releaseLock } from "./lock";
import { downloadCurseforge } from "./sources/curseforge";
import { atomicWrite, readState, type State, safeFolder, validateState, writeState } from "./state";
import { tocMatchesFolder } from "./toc";
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
export async function protectedFolder(ctx: Context, folder: string): Promise<boolean> {
  if (!safeFolder(folder))
    throw new WowaddonError("STATE_CORRUPT", "Unsafe addon folder in state.");
  const target = join(ctx.addonsDir, folder);
  const targetInfo = await info(target);
  if (targetInfo?.isSymbolicLink()) return true;
  if (targetInfo?.isDirectory() && (await containsGit(target))) return true;
  let ancestor = ancestorProtection.get(ctx);
  if (!ancestor) {
    ancestor = insideWorktree(ctx);
    ancestorProtection.set(ctx, ancestor);
  }
  return ancestor;
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
};
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
  const key = projectKeys[entry.kind];
  const name = impliedFolder(entry);
  const id = key && new RegExp(`^\\s*##\\s*${key}\\s*:\\s*${entry.ref}\\s*$`, "im");
  for (const item of await readdir(ctx.addonsDir, { withFileTypes: true })) {
    if (!safeFolder(item.name) || !(await protectedFolder(ctx, item.name))) continue;
    if (folderKey(item.name) === name) return item.name;
    if (!id) continue;
    const dir = join(ctx.addonsDir, item.name);
    const files = await readdir(dir).catch(() => []);
    for (const file of files)
      if (tocMatchesFolder(file, item.name) && id.test(await readFile(join(dir, file), "utf8")))
        return item.name;
  }
  return undefined;
}
export async function isProtected(
  ctx: Context,
  entry: Entry,
  installed?: Installed,
): Promise<boolean> {
  if (!installed) return (await devFolderFor(ctx, entry)) !== undefined;
  for (const folder of installed.folders) if (await protectedFolder(ctx, folder)) return true;
  return false;
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
export interface InstallOptions {
  adopt?: boolean;
  // Stops once the download is read and the folders are checked: the row says what a real run would do.
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  // Runs after the download is read, just before the AddOns folder changes.
  beforeChange?: () => Promise<void>;
  rename?: typeof rename;
}
async function preflight(
  ctx: Context,
  state: State,
  id: string,
  folders: string[],
  adopt: boolean,
): Promise<boolean> {
  await assertRoot(ctx);
  for (const folder of folders) if (await protectedFolder(ctx, folder)) return false;
  const existing = new Map(
    (await readdir(ctx.addonsDir)).map((folder) => [folder.toLowerCase(), folder]),
  );
  for (const folder of folders) {
    for (const [owner, installed] of Object.entries(state.addons)) {
      if (
        owner !== id &&
        installed.folders.some((name) => name.toLowerCase() === folder.toLowerCase())
      )
        throw new WowaddonError("OWNED_BY_OTHER", `${folder} is owned by ${owner}.`);
    }
    const actual = existing.get(folder.toLowerCase());
    if (actual && actual !== folder)
      throw new WowaddonError(
        "FOLDER_COLLISION",
        `${folder} collides with existing folder ${actual}.`,
      );
    const target = await info(join(ctx.addonsDir, folder));
    if (target && !target.isDirectory())
      throw new WowaddonError("FOLDER_COLLISION", `${folder} is not an addon directory.`);
    if (target && !state.addons[id]?.folders.includes(folder) && !adopt)
      throw new WowaddonError(
        "UNMANAGED",
        `${folder} is already installed outside wowaddon. Use --adopt to take it over.`,
      );
  }
  return true;
}
const installFolders = (state: State, id: string, archive: Archive) => [
  ...new Set([...(state.addons[id]?.folders ?? []), ...archive.folders]),
];
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
  const folders = installFolders(state, id, archive);
  if (!(await preflight(ctx, state, id, folders, !!opts.adopt))) return false;
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
    if (!(await preflight(ctx, state, id, folders, !!opts.adopt))) return false;
    const pending: Pending = {
      schema: 1,
      addonsDir: ctx.addonsDir,
      txDir,
      before: structuredClone(state),
      operations: [],
    };
    for (const folder of folders)
      pending.operations.push({
        folder,
        hadOld: !!(await info(join(ctx.addonsDir, folder))),
        putNew: archive.folders.includes(folder),
      });
    checkAbort(opts.signal);
    await atomicWrite(pendingPath(ctx), `${JSON.stringify(pending, null, 2)}\n`);
    recorded = true;
    try {
      for (const operation of pending.operations) {
        checkAbort(opts.signal);
        if (!(await preflight(ctx, state, id, [operation.folder], !!opts.adopt)))
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
  const skipDev = (): Row => {
    progress("skipped", DEV_SKIPPED);
    return { entry, installed, latest: release, status: "dev", message: DEV_SKIPPED };
  };
  if (await isProtected(ctx, entry, installed)) return skipDev();
  const present = !!installed && (await foldersPresent(ctx, installed));
  if (present && installed?.versionKey === release.versionKey) {
    progress("skipped", "up to date");
    return { entry, installed, latest: release, status: "current", message: "up to date" };
  }
  progress("downloading");
  const bytes =
    entry.kind === "cf"
      ? await downloadCurseforge(ctx, release, opts.signal)
      : await requestBytes(release.url, {
          credentials: await getCredentials(ctx),
          signal: opts.signal,
        });
  const archive = await readArchive(bytes, {
    flavor: ctx.flavor,
    source: release.archive === "source",
    signal: opts.signal,
  });
  if (opts.dryRun) {
    const folders = installFolders(state, entry.id, archive);
    if (!(await preflight(ctx, state, entry.id, folders, !!opts.adopt))) return skipDev();
    return {
      entry,
      installed,
      latest: release,
      status: present ? "update" : "missing",
      message: release.note,
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
  if (!(await transact(ctx, state, entry.id, archive, next, opts))) return skipDev();
  progress("done", release.note);
  return { entry, installed: next, latest: release, status: "current", message: release.note };
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
