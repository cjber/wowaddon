import { type FileHandle, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMissing } from "./config";
import { type Context, WowaddonError } from "./types";

const lockPath = (ctx: Context) => join(ctx.configDir, "state", `${ctx.flavor}.lock`);
// No wowaddon operation runs this long, so an older lock whose PID is alive belongs to a
// process that reused the PID of a crashed run.
export const LOCK_MAX_AGE_MS = 60 * 60 * 1000;
export async function releaseLock(ctx: Context, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath(ctx), "utf8")) === token) await rm(lockPath(ctx));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
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
    await releaseLock(ctx, expected);
  } finally {
    await guard.close();
    await rm(guardPath);
  }
}
async function tryLock(ctx: Context, token: string): Promise<boolean> {
  let lock: FileHandle;
  try {
    lock = await open(lockPath(ctx), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await lock.writeFile(token);
    await lock.sync();
  } finally {
    await lock.close();
  }
  return true;
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (probe) {
    const code = (probe as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM: the process exists but belongs to another user.
    if (code === "EPERM") return true;
    throw probe;
  }
}
function assertStale(ctx: Context, existing: string): void {
  let pid: unknown;
  let startedAt: unknown;
  try {
    ({ pid, startedAt } = JSON.parse(existing));
  } catch {
    throw new WowaddonError(
      "LOCKED",
      `Invalid lock file: ${lockPath(ctx)}. Check for a running wowaddon process before removing it.`,
    );
  }
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    throw new WowaddonError("LOCKED", "Invalid wowaddon lock PID.");
  const expired =
    typeof startedAt === "number" &&
    Number.isFinite(startedAt) &&
    Date.now() - startedAt > LOCK_MAX_AGE_MS;
  if (!expired && processAlive(pid))
    throw new WowaddonError(
      "LOCKED",
      `Another wowaddon operation is running (PID ${pid}). If it is not, remove ${lockPath(ctx)}.`,
    );
}
// Takes the flavor's lock, reclaiming a stale one, and returns the token releaseLock needs.
export async function acquireLock(ctx: Context): Promise<string> {
  await mkdir(dirname(lockPath(ctx)), { recursive: true });
  const token = JSON.stringify({
    pid: process.pid,
    token: crypto.randomUUID(),
    startedAt: Date.now(),
  });
  // Every reclaim is followed by another attempt, so the last stale lock is never left unretried.
  let acquired = await tryLock(ctx, token);
  for (let attempt = 0; !acquired && attempt < 3; attempt++) {
    let existing: string | undefined;
    try {
      existing = await readFile(lockPath(ctx), "utf8");
    } catch (readError) {
      if (!isMissing(readError)) throw readError;
    }
    if (existing !== undefined) {
      assertStale(ctx, existing);
      await reclaimLock(ctx, existing);
    }
    acquired = await tryLock(ctx, token);
  }
  if (!acquired) throw new WowaddonError("LOCKED", "Could not acquire the wowaddon lock.");
  return token;
}
