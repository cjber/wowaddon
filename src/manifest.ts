import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissing } from "./config";
import { canonicalId, parseRef } from "./refs";
import { atomicWrite } from "./state";
import { type Context, type Entry, WowaddonError } from "./types";

export const manifestPath = (ctx: Context): string => join(ctx.configDir, `${ctx.flavor}.txt`);
export async function readManifest(
  ctx: Context,
  resolveCf?: (slug: string) => Promise<string>,
): Promise<Entry[]> {
  let content: string;
  try {
    content = await readFile(manifestPath(ctx), "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const [spec, ...comments] = line.split("#");
    if (!spec.trim()) continue;
    const parsed = parseRef(spec.trim());
    if (parsed.kind === "cf" && !/^\d+$/.test(parsed.ref)) {
      if (!resolveCf)
        throw new WowaddonError(
          "UNRESOLVED_REF",
          `Refresh to resolve legacy CurseForge name: ${parsed.ref}`,
        );
      parsed.ref = await resolveCf(parsed.ref);
    }
    const id = canonicalId(parsed.kind, parsed.ref);
    if (seen.has(id)) throw new WowaddonError("DUPLICATE", `Duplicate addon in manifest: ${id}`);
    seen.add(id);
    const note = comments.join("#").trim();
    entries.push({ ...parsed, id, ...(note ? { note } : {}) });
  }
  return entries;
}
export async function writeManifest(ctx: Context, entries: Entry[]): Promise<void> {
  const seen = new Set<string>();
  const content = entries
    .map((entry) => {
      if (entry.id !== canonicalId(entry.kind, entry.ref))
        throw new WowaddonError("INVALID_REF", "Manifest entry has a non-canonical ID.");
      if (seen.has(entry.id)) throw new WowaddonError("DUPLICATE", `Duplicate addon: ${entry.id}`);
      seen.add(entry.id);
      return `${entry.kind} ${entry.ref}${entry.note ? `  # ${entry.note.replace(/[\r\n]/g, " ")}` : ""}\n`;
    })
    .join("");
  await atomicWrite(manifestPath(ctx), content);
}
