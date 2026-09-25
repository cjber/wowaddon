import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Archive, readArchive } from "./archive";
import { isMissing } from "./config";
import { checkAbort, getCredentials, requestBytes } from "./http";
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

const lockPath = (ctx: Context) => join(ctx.configDir, "state", `${ctx.flavor}.lock`);
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
  for (let cursor = ctx.addonsDir; ; cursor = dirname(cursor)) {
    if (await info(join(cursor, ".git"))) return true;
    if (dirname(cursor) === cursor) break;
  }
  return false;
}
async function reclaimLock(ctx: Context, expected: string): Promise<void> {
  const guardPath = `${lockPath(ctx)}.reclaim`;
  let guard: FileHandle;
  try {
    guard = await open(guardPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new WowaddonError(
        "LOCKED",
        `Stale-lock recovery is already running. If it was interrupted, remove ${guardPath} before retrying.`,
      );
    throw error;
  }
  try {
    try {
      if ((await readFile(lockPath(ctx), "utf8")) === expected) await rm(lockPath(ctx));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  } finally {
    await guard.close();
    await rm(guardPath);
  }
}
const projectKeys: Partial<Record<Entry["kind"], string>> = {
  cf: "X-Curse-Project-ID",
  wowi: "X-WoWI-ID",
};
// A dev folder (symlink or checkout) whose TOC carries this addon's own project ID: found before
// the first install, when state doesn't know the addon's folders yet.
async function devFolderFor(ctx: Context, entry: Entry): Promise<string | undefined> {
  const key = projectKeys[entry.kind];
  if (!key) return undefined;
  const id = new RegExp(`^\\s*##\\s*${key}\\s*:\\s*${entry.ref}\\s*$`, "im");
  for (const item of await readdir(ctx.addonsDir, { withFileTypes: true })) {
    if (!safeFolder(item.name) || !(await protectedFolder(ctx, item.name))) continue;
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
async function releaseLock(ctx: Context, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath(ctx), "utf8")) === token) await rm(lockPath(ctx));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
export async function withInstallLock<T>(
  ctx: Context,
  work: (state: State) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(lockPath(ctx)), { recursive: true });
  const token = JSON.stringify({ pid: process.pid, token: crypto.randomUUID() });
  let acquired = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const lock = await open(lockPath(ctx), "wx", 0o600);
      try {
        await lock.writeFile(token);
        await lock.sync();
      } finally {
        await lock.close();
      }
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: string;
      try {
        existing = await readFile(lockPath(ctx), "utf8");
      } catch (readError) {
        if (isMissing(readError)) continue;
        throw readError;
      }
      let pid: number;
      try {
        pid = JSON.parse(existing).pid;
      } catch {
        throw new WowaddonError(
          "LOCKED",
          `Invalid lock file: ${lockPath(ctx)}. Check for a running wowaddon process before removing it.`,
        );
      }
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new WowaddonError("LOCKED", "Invalid wowaddon lock PID.");
      try {
        process.kill(pid, 0);
        throw new WowaddonError("LOCKED", `Another wowaddon operation is running (PID ${pid}).`);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      }
      await reclaimLock(ctx, existing);
    }
  }
  if (!acquired) throw new WowaddonError("LOCKED", "Could not acquire the wowaddon lock.");
  try {
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
    if (await protectedFolder(ctx, operation.folder))
      throw new WowaddonError(
        "RECOVERY_BLOCKED",
        `Cannot recover protected folder ${operation.folder}; backups remain in ${pending.txDir}.`,
      );
    if (await info(backup)) {
      await rm(target, { recursive: true, force: true });
      await rename(backup, target);
    } else if (!operation.hadOld && operation.putNew && !(await info(staged))) {
      await rm(target, { recursive: true, force: true });
    } else if (operation.hadOld && !(await info(target))) {
      throw new WowaddonError(
        "RECOVERY_BLOCKED",
        `Missing original and backup for ${operation.folder}; preserve ${pending.txDir}.`,
      );
    }
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
export interface InstallOptions {
  adopt?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
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
  const folders = [...new Set([...(state.addons[id]?.folders ?? []), ...archive.folders])];
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
          throw new WowaddonError("DEV_PROTECTED", "dev link, skipped");
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
  if (await isProtected(ctx, entry, installed)) {
    progress("skipped", "dev link, skipped");
    return { entry, installed, latest: release, status: "dev", message: "dev link, skipped" };
  }
  if (installed?.versionKey === release.versionKey && (await foldersPresent(ctx, installed))) {
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
  progress("installing");
  const next: Installed = {
    version: release.version,
    versionKey: release.versionKey,
    folders: archive.folders,
    installedAt: new Date().toISOString(),
  };
  if (!(await transact(ctx, state, entry.id, archive, next, opts))) {
    progress("skipped", "dev link, skipped");
    return { entry, installed, latest: release, status: "dev", message: "dev link, skipped" };
  }
  progress("done", release.note);
  return { entry, installed: next, latest: release, status: "current", message: release.note };
}
export async function removeInstalled(
  ctx: Context,
  state: State,
  id: string,
  opts: InstallOptions = {},
): Promise<void> {
  if (!state.addons[id]) return;
  if (!(await transact(ctx, state, id, { folders: [], files: new Map() }, undefined, opts)))
    throw new WowaddonError("DEV_PROTECTED", "dev link, skipped");
}
