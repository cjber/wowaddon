import { stat } from "node:fs/promises";
import { join } from "node:path";
import { flavors } from "../flavors";
import { requestJson } from "../http";
import { atomicWrite } from "../state";
import { bbcodeToText, firstLines } from "../text";
import {
  type AddonInfo,
  type Category,
  type Context,
  type Flavor,
  type Listing,
  WowaddonError,
} from "../types";
import { flavorList, matchCategory, type Query, relevance, unique, words } from "./query";

// WoWInterface's API has no search: it serves its whole file list (about 6 MB) and per-file
// details, so search, sort and category filters run locally over a cached copy. Its compatibility
// tags name game patches (1.15.x is Classic Era); none names WoW: Forever.
const API = "https://api.mmoui.com/v3/game/WOW";
const LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface WowiFile {
  UID: string;
  UICATID: string;
  UIVersion: string;
  UIDate: number | string;
  UIName: string;
  UIAuthorName: string;
  UIFileInfoURL: string;
  UIDownloadTotal: string;
  UIDownloadMonthly: string;
  UICompatibility: { version: string; name: string }[] | null;
  UIDir: string[];
}
interface WowiCategory {
  UICATID: string;
  UICATTitle: string;
  UICATFileCount?: string;
  UICATParentIDs?: string[];
}

const listPath = (ctx: Context) => join(ctx.configDir, "cache", "wowi-filelist.json");

function validList(data: unknown): data is WowiFile[] {
  return Array.isArray(data) && data.every((file) => typeof file?.UID === "string");
}
// The file list is cached for six hours; a stale cache still serves when the API is down.
export async function wowiFiles(ctx: Context, signal?: AbortSignal): Promise<WowiFile[]> {
  const path = listPath(ctx);
  const cached = async () => {
    const data = await Bun.file(path).json();
    if (!validList(data)) throw new WowaddonError("SOURCE_RESPONSE", "Invalid WoWInterface cache.");
    return data;
  };
  const age = await stat(path).then(
    (info) => Date.now() - info.mtimeMs,
    () => Infinity,
  );
  if (age < LIST_MAX_AGE_MS) return cached().catch(() => fetchList(ctx, signal));
  try {
    return await fetchList(ctx, signal);
  } catch (error) {
    if (age === Infinity || (error instanceof WowaddonError && error.code === "ABORTED"))
      throw error;
    return cached().catch(() => {
      throw error;
    });
  }
}
async function fetchList(ctx: Context, signal?: AbortSignal): Promise<WowiFile[]> {
  const data = await requestJson<unknown>(`${API}/filelist.json`, { signal });
  if (!validList(data))
    throw new WowaddonError("SOURCE_RESPONSE", "WoWInterface returned an invalid file list.");
  await atomicWrite(listPath(ctx), JSON.stringify(data));
  return data;
}

export async function wowiCategories(_ctx: Context, signal?: AbortSignal): Promise<Category[]> {
  const data = await requestJson<WowiCategory[]>(`${API}/categorylist.json`, { signal });
  if (!Array.isArray(data))
    throw new WowaddonError("SOURCE_RESPONSE", "WoWInterface returned an invalid category list.");
  const names = new Map(data.map((category) => [category.UICATID, category.UICATTitle]));
  return data
    .map((category) => {
      const parent = (category.UICATParentIDs ?? [])
        .map((id) => names.get(id))
        .filter(Boolean)
        .at(-1);
      return {
        kind: "wowi" as const,
        id: category.UICATID,
        name: category.UICATTitle,
        ...(parent ? { parent } : {}),
        ...(category.UICATFileCount ? { count: Number(category.UICATFileCount) } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function wowiFlavors(file: WowiFile): Flavor[] {
  const versions = (file.UICompatibility ?? []).map((tag) => tag.version);
  return flavorList((flavor) => versions.some((version) => flavors[flavor].version.test(version)));
}
const date = (value: number | string) => {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
};
export function wowiListing(file: WowiFile, categories: Map<string, string>): Listing {
  const category = categories.get(file.UICATID);
  return {
    ref: `wowi:${file.UID}`,
    kind: "wowi",
    name: file.UIName,
    summary: "",
    authors: file.UIAuthorName ? [file.UIAuthorName] : [],
    downloads: Number(file.UIDownloadTotal) || 0,
    updated: date(file.UIDate),
    categories: category ? [category] : [],
    gameVersions: unique((file.UICompatibility ?? []).map((tag) => tag.version)).sort(),
    flavors: wowiFlavors(file),
    url: file.UIFileInfoURL,
  };
}

export async function wowiSearch(
  ctx: Context,
  query: Query,
  signal?: AbortSignal,
): Promise<Listing[]> {
  if (!query.allFlavors && ctx.flavor === "forever")
    throw new WowaddonError(
      "NO_FLAVOR_TAG",
      "WoWInterface does not tag WoW: Forever builds; --all-flavors shows its other files.",
    );
  const [files, categories] = await Promise.all([
    wowiFiles(ctx, signal),
    wowiCategories(ctx, signal).catch(() => [] as Category[]),
  ]);
  let category: Category | undefined;
  if (query.category) {
    category = matchCategory(categories, query.category);
    if (!category)
      throw new WowaddonError("CATEGORY", `WoWInterface has no category named ${query.category}.`);
  }
  const wanted = words(query.text ?? "");
  const matches = files.filter((file) => {
    if (category && file.UICATID !== category.id) return false;
    if (!query.allFlavors && !wowiFlavors(file).includes(ctx.flavor)) return false;
    const have = words(`${file.UIName} ${file.UIAuthorName}`).join(" ");
    return wanted.every((word) => have.includes(word));
  });
  const total = (file: WowiFile) => Number(file.UIDownloadTotal) || 0;
  const order: Record<Query["order"], (a: WowiFile, b: WowiFile) => number> = {
    relevance: (a, b) =>
      relevance(b.UIName, query.text) - relevance(a.UIName, query.text) || total(b) - total(a),
    downloads: (a, b) => total(b) - total(a),
    trending: (a, b) => (Number(b.UIDownloadMonthly) || 0) - (Number(a.UIDownloadMonthly) || 0),
    updated: (a, b) => Number(b.UIDate) - Number(a.UIDate),
    name: (a, b) => a.UIName.localeCompare(b.UIName),
  };
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const start = (query.page - 1) * query.limit;
  return matches
    .sort(order[query.order])
    .slice(start, start + query.limit)
    .map((file) => wowiListing(file, names));
}

interface WowiDetails {
  UID: string;
  UIVersion: string;
  UIDate: string | number;
  UIName: string;
  UIAuthorName?: string;
  UIDescription?: string;
  UIChangeLog?: string;
  UIHitCount?: string;
}
export async function wowiInfo(ctx: Context, id: string, signal?: AbortSignal): Promise<AddonInfo> {
  const [details, files, categories] = await Promise.all([
    requestJson<WowiDetails[]>(`${API}/filedetails/${id}.json`, { signal }),
    wowiFiles(ctx, signal).catch(() => [] as WowiFile[]),
    wowiCategories(ctx, signal).catch(() => [] as Category[]),
  ]);
  const file = Array.isArray(details) ? details[0] : undefined;
  if (!file || String(file.UID) !== id || typeof file.UIName !== "string")
    throw new WowaddonError("SOURCE_RESPONSE", "WoWInterface returned invalid file details.");
  const listed = files.find((candidate) => candidate.UID === id);
  const url = `https://www.wowinterface.com/downloads/info${id}`;
  const base = listed
    ? wowiListing(listed, new Map(categories.map((c) => [c.id, c.name])))
    : {
        ref: `wowi:${id}`,
        kind: "wowi" as const,
        name: file.UIName,
        summary: "",
        authors: file.UIAuthorName ? [file.UIAuthorName] : [],
        downloads: Number(file.UIHitCount) || null,
        updated: date(file.UIDate),
        categories: [],
        gameVersions: [],
        flavors: [],
        url,
      };
  const description = bbcodeToText(file.UIDescription ?? "");
  return {
    ...base,
    summary: description.split("\n").find(Boolean)?.slice(0, 200) ?? "",
    version: file.UIVersion ?? null,
    links: { website: base.url },
    folders: listed?.UIDir ?? [],
    description: firstLines(description, 1500),
    changelog: file.UIChangeLog
      ? { version: file.UIVersion ?? null, text: firstLines(bbcodeToText(file.UIChangeLog), 2000) }
      : null,
  };
}
