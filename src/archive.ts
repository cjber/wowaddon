import { mkdir, open, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Entry, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { stripFlavorSuffix } from "./flavors";
import { checkAbort } from "./http";
import { safeFolder } from "./state";
import { tocMatchesFolder, tocSupports, tocVersion } from "./toc";
import { type Flavor, WowaddonError } from "./types";

export interface Archive {
  folders: string[];
  versions: ReadonlyMap<string, string | undefined>;
  extract(stagingDir?: string): Promise<void>;
}
export interface ArchiveOptions {
  flavor: Flavor;
  source?: boolean;
  signal?: AbortSignal;
  maxEntries?: number;
  maxBytes: number;
  availableBytes?: typeof availableArchiveBytes;
}
function bad(message: string): never {
  throw new WowaddonError("ARCHIVE_INVALID", message);
}
// Windows-made ZIPs (AtlasLoot Classic Forever among them) separate paths with backslashes, against
// the ZIP spec; read them as slashes, so every segment still meets the same checks. Their folder
// entries end in a backslash, which zip.js does not count as a directory.
function zipPath(entry: Entry): { path: string; directory: boolean } {
  const name = entry.filename.replaceAll("\\", "/");
  const directory = entry.directory || name.endsWith("/");
  const path = name.replace(/\/$/, "");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !safeFolder(part)))
    bad(`Unsafe ZIP path: ${entry.filename}`);
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (
    (mode && mode !== 0o100000 && mode !== 0o040000) ||
    (mode === 0o040000 && !directory) ||
    (mode === 0o100000 && directory)
  )
    bad(`ZIP contains a symlink or special entry: ${entry.filename}`);
  return { path, directory };
}
export async function availableArchiveBytes(path: string): Promise<number> {
  const fs = await statfs(path, { bigint: true });
  return Number(fs.bavail * (fs.frsize || fs.bsize));
}
function checkSpace(declared: number, available: number) {
  if (!Number.isSafeInteger(declared) || declared > available)
    bad("ZIP exceeds the available disk space at the install target.");
}
function archiveError(error: unknown, signal?: AbortSignal): never {
  checkAbort(signal);
  if (error instanceof WowaddonError) throw error;
  throw new WowaddonError(
    "ARCHIVE_INVALID",
    `Cannot read ZIP: ${error instanceof Error ? error.message : "invalid archive"}`,
  );
}
async function streamEntry(
  entry: Extract<Entry, { directory: false }>,
  write: (chunk: Uint8Array) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  let size = 0;
  await entry.getData(
    new WritableStream<Uint8Array>({
      async write(chunk) {
        size += chunk.length;
        if (size > entry.uncompressedSize) bad(`Invalid ZIP size: ${entry.filename}`);
        await write(chunk);
      },
    }),
    { signal, checkSignature: true },
  );
  if (size !== entry.uncompressedSize) bad(`Invalid ZIP size: ${entry.filename}`);
}
async function readToc(entry: Extract<Entry, { directory: false }>, signal?: AbortSignal) {
  const decoder = new TextDecoder();
  let text = "";
  await streamEntry(
    entry,
    (chunk) => {
      text += decoder.decode(chunk, { stream: true });
    },
    signal,
  );
  return text + decoder.decode();
}
async function stageEntry(
  entry: Extract<Entry, { directory: false }>,
  destination: string,
  signal?: AbortSignal,
) {
  await mkdir(dirname(destination), { recursive: true });
  const file = await open(destination, "wx", 0o644);
  try {
    await streamEntry(entry, (chunk) => file.writeFile(chunk), signal);
  } finally {
    await file.close();
  }
}

export async function readArchive(bytes: Uint8Array, opts: ArchiveOptions): Promise<Archive> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    strictness: "strict",
  });
  try {
    const files: { entry: Extract<Entry, { directory: false }>; path: string }[] = [];
    let count = 0;
    const names = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
    let declared = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      checkAbort(opts.signal);
      if (++count > (opts.maxEntries ?? 20000)) bad("ZIP exceeds the entry count limit.");
      const { path, directory: isDirectory } = zipPath(entry);
      const parts = path.split("/");
      for (let n = 1; n <= parts.length; n++) {
        const prefix = parts.slice(0, n).join("/");
        const key = prefix.normalize("NFC").toLowerCase();
        const directory = n < parts.length || isDirectory;
        const explicit = n === parts.length;
        const previous = names.get(key);
        if (
          previous &&
          (previous.path !== prefix ||
            previous.directory !== directory ||
            (explicit && previous.explicit))
        )
          bad(`ZIP has a case collision or duplicate path: ${path}`);
        names.set(key, { path: prefix, directory, explicit: explicit || !!previous?.explicit });
      }
      declared += entry.uncompressedSize;
      checkSpace(declared, opts.maxBytes);
      if (!isDirectory && !entry.directory) files.push({ entry, path });
    }

    const tocs = new Map<Entry, { compatible: boolean; version?: string }>();
    async function tocInfo(entry: Extract<Entry, { directory: false }>) {
      const cached = tocs.get(entry);
      if (cached) return cached;
      const text = await readToc(entry, opts.signal);
      const result = { compatible: tocSupports(text, opts.flavor), version: tocVersion(text) };
      tocs.set(entry, result);
      return result;
    }
    if (opts.source) {
      const roots = new Set(files.map(({ path }) => path.split("/")[0]));
      if (roots.size !== 1 || files.some(({ path }) => !path.includes("/")))
        bad("Source ZIP must contain one repository root.");
      const folderNames = new Set<string>();
      for (const file of files) {
        file.path = file.path.slice(file.path.indexOf("/") + 1);
        if (
          !file.path.includes("/") &&
          /\.toc$/i.test(file.path) &&
          (await tocInfo(file.entry)).compatible
        )
          folderNames.add(stripFlavorSuffix(file.path.slice(0, -4)));
      }
      if (folderNames.size > 1) bad("Source ZIP has ambiguous TOC folder names.");
      if (folderNames.size) {
        const [folder] = folderNames;
        if (!safeFolder(folder)) bad("Unsafe source addon folder name.");
        for (const file of files) file.path = `${folder}/${file.path}`;
      }
    }

    const compatible = new Set<string>();
    const versions = new Map<string, string | undefined>();
    for (const { path, entry } of files) {
      const [top, file, ...rest] = path.split("/");
      if (!file || rest.length || !tocMatchesFolder(file, top)) continue;
      const toc = await tocInfo(entry);
      if (!toc.compatible) continue;
      compatible.add(top);
      const key = top.toLowerCase();
      if (!versions.has(key)) versions.set(key, toc.version);
    }
    const shouldStage = (path: string) => {
      const slash = path.indexOf("/");
      return slash >= 0 && compatible.has(path.slice(0, slash));
    };
    const stagedBytes = files.reduce(
      (total, { path, entry }) => total + (shouldStage(path) ? entry.uncompressedSize : 0),
      0,
    );
    let validated = false;
    async function extract(stagingDir?: string) {
      if (!stagingDir && validated) return;
      try {
        if (stagingDir) {
          const available = await (opts.availableBytes ?? availableArchiveBytes)(stagingDir);
          checkSpace(stagedBytes, available);
        }
        for (const { path, entry } of files) {
          if (stagingDir && shouldStage(path))
            await stageEntry(entry, join(stagingDir, path), opts.signal);
          else if (!validated && !tocs.has(entry)) await streamEntry(entry, () => {}, opts.signal);
        }
        validated = true;
      } catch (error) {
        archiveError(error, opts.signal);
      }
    }
    const folders = [...compatible].sort();
    if (!folders.length) {
      await extract();
      throw new WowaddonError(
        "NO_BUILD",
        "Archive has no compatible addon folders for this flavor.",
      );
    }

    return { folders, versions, extract };
  } catch (error) {
    archiveError(error, opts.signal);
  } finally {
    await reader.close();
  }
}
