import { type Entry, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { stripFlavorSuffix } from "./flavors";
import { checkAbort } from "./http";
import { safeFolder } from "./state";
import { tocMatchesFolder, tocSupports } from "./toc";
import { type Flavor, WowaddonError } from "./types";

export interface Archive {
  folders: string[];
  files: Map<string, Uint8Array>;
}
export interface ArchiveOptions {
  flavor: Flavor;
  source?: boolean;
  signal?: AbortSignal;
  maxEntries?: number;
  maxBytes?: number;
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
export async function readArchive(bytes: Uint8Array, opts: ArchiveOptions): Promise<Archive> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    strictness: "strict",
  });
  const maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
  try {
    const entries: { entry: Entry; path: string; directory: boolean }[] = [];
    const names = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
    let declared = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      checkAbort(opts.signal);
      if (entries.length >= (opts.maxEntries ?? 20000)) bad("ZIP exceeds the entry count limit.");
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
      if (!Number.isSafeInteger(declared) || declared > maxBytes)
        bad("ZIP exceeds the uncompressed size limit.");
      entries.push({ entry, path, directory: isDirectory });
    }
    const files = new Map<string, Uint8Array>();
    let actual = 0;
    for (const { entry, path, directory } of entries) {
      if (directory || entry.directory) continue;
      checkAbort(opts.signal);
      const chunks: Uint8Array[] = [];
      let size = 0;
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            size += chunk.length;
            actual += chunk.length;
            if (actual > maxBytes || size > entry.uncompressedSize)
              bad("ZIP exceeds the uncompressed size limit.");
            chunks.push(chunk);
          },
        }),
        { signal: opts.signal, checkSignature: true },
      );
      if (size !== entry.uncompressedSize) bad(`Invalid ZIP size: ${path}`);
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      files.set(path, data);
    }
    let mapped = files;
    if (opts.source) {
      const roots = new Set([...files.keys()].map((path) => path.split("/")[0]));
      if (roots.size !== 1 || [...files.keys()].some((path) => !path.includes("/")))
        bad("Source ZIP must contain one repository root.");
      mapped = new Map([...files].map(([path, data]) => [path.slice(path.indexOf("/") + 1), data]));
      const tocs = [...mapped].filter(
        ([path, data]) =>
          !path.includes("/") &&
          /\.toc$/i.test(path) &&
          tocSupports(new TextDecoder().decode(data), opts.flavor),
      );
      if (tocs.length) {
        const folderNames = new Set(tocs.map(([path]) => stripFlavorSuffix(path.slice(0, -4))));
        if (folderNames.size !== 1) bad("Source ZIP has ambiguous TOC folder names.");
        const folder = [...folderNames][0];
        if (!safeFolder(folder)) bad("Unsafe source addon folder name.");
        mapped = new Map([...mapped].map(([path, data]) => [`${folder}/${path}`, data]));
      }
    }
    const candidates = new Set(
      [...mapped.keys()].filter((path) => path.includes("/")).map((path) => path.split("/")[0]),
    );
    const folders = [...candidates]
      .filter((folder) =>
        [...mapped].some(([path, data]) => {
          const [top, file, ...rest] = path.split("/");
          return (
            top === folder &&
            rest.length === 0 &&
            tocMatchesFolder(file, folder) &&
            tocSupports(new TextDecoder().decode(data), opts.flavor)
          );
        }),
      )
      .sort();
    if (!folders.length)
      throw new WowaddonError(
        "NO_BUILD",
        "Archive has no compatible addon folders for this flavor.",
      );
    return {
      folders,
      files: new Map([...mapped].filter(([path]) => folders.includes(path.split("/")[0]))),
    };
  } catch (error) {
    checkAbort(opts.signal);
    if (error instanceof WowaddonError) throw error;
    throw new WowaddonError(
      "ARCHIVE_INVALID",
      `Cannot read ZIP: ${error instanceof Error ? error.message : "invalid archive"}`,
    );
  } finally {
    await reader.close();
  }
}
