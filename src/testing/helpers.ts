import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TextReader,
  Uint8ArrayWriter,
  ZipWriter,
  type ZipWriterAddDataOptions,
} from "@zip.js/zip.js";
import { openContext } from "../config";
import { type Fetch, setFetch } from "../http";
import type { Context, Flavor } from "../types";

export async function tempContext(
  flavor: Flavor = "forever",
): Promise<{ ctx: Context; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "wowaddon-test-"));
  const addonsDir = join(root, "Interface", "AddOns");
  await mkdir(addonsDir, { recursive: true });
  const ctx = await openContext({
    flavor,
    addonsDir,
    env: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), GH_TOKEN: "test-gh", CF_API_KEY: "" },
  });
  return { ctx, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export function offline(): void {
  setFetch(async (url) => {
    throw new Error(`Unexpected network request: ${url}`);
  });
}
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
export function routeFetch(routes: Record<string, unknown>): { calls: string[]; fetch: Fetch } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      if (!(url in routes)) throw new Error(`Unexpected network request: ${url}`);
      const value = routes[url];
      return value instanceof Response ? value.clone() : json(value);
    },
  };
}
export async function zip(
  files: Record<string, string>,
  options: Record<string, ZipWriterAddDataOptions> = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, text] of Object.entries(files))
    await writer.add(name, new TextReader(text), options[name]);
  return writer.close();
}
