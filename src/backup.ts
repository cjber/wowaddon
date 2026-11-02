import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { isMissing } from "./config";
import { type Context, WowaddonError } from "./types";

const BACKUP_NAME = /^WTF-\d{4}-\d{2}-\d{2}T[\d-]+Z\.zip$/;

// WTF sits beside Interface: <client>/Interface/AddOns and <client>/WTF.
const wtfPath = (ctx: Context): string => join(dirname(dirname(ctx.addonsDir)), "WTF");

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) found.push(...(await files(path)));
    else if (item.isFile()) found.push(path);
  }
  return found;
}

// Snapshots the flavor's WTF folder (settings and SavedVariables) to a timestamped ZIP and keeps
// the newest ctx.backups.keep of them. Returns the archive path, or undefined when backups are
// off or there is no WTF folder yet.
export async function backupWtf(ctx: Context): Promise<string | undefined> {
  const wtf = wtfPath(ctx);
  if (ctx.backups.keep === 0) return undefined;
  try {
    if (!(await stat(wtf)).isDirectory()) return undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const path = join(ctx.backups.dir, `WTF-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    await mkdir(ctx.backups.dir, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      const zip = new ZipWriter(
        new WritableStream<Uint8Array>({
          write: async (chunk) => {
            await handle.write(chunk);
          },
        }),
        { useWebWorkers: false },
      );
      for (const file of await files(wtf))
        await zip.add(relative(dirname(wtf), file), new Uint8ArrayReader(await readFile(file)));
      await zip.close();
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    created = false;
    const backups = (await readdir(ctx.backups.dir))
      .filter((name) => BACKUP_NAME.test(name))
      .sort();
    for (const old of backups.slice(0, -ctx.backups.keep)) await rm(join(ctx.backups.dir, old));
    return path;
  } catch (error) {
    if (created) await rm(temporary, { force: true });
    throw new WowaddonError(
      "BACKUP_FAILED",
      `Could not back up ${wtf}, so nothing was changed: ${error instanceof Error ? error.message : String(error)}. Use --no-backup to sync without one.`,
    );
  }
}
