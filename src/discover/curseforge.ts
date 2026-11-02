import { flavors } from "../flavors";
import { getCredentials, requestJson } from "../http";
import { resolveCfProject } from "../sources/curseforge";
import { firstLines, htmlToText } from "../text";
import {
  type AddonInfo,
  type Category,
  type Context,
  type Flavor,
  type Listing,
  WowaddonError,
} from "../types";
import { flavorList, matchCategory, type Order, type Query, unique, versionSort } from "./query";

// CurseForge's own site refuses keyless search (www.curseforge.com/api/v1/mods/search answers 403),
// so search, browse and project details use the official v1 API shape: api.curseforge.com with the
// user's key, or the public api.curse.tools mirror of the same API without one. Neither gets a key
// it should not: http.ts sends the key to api.curseforge.com only. Installs never use the mirror.
export const CURSE_TOOLS = "https://api.curse.tools/v1";
const OFFICIAL = "https://api.curseforge.com/v1";
const WOW = 1;
const ADDONS = 1;
const sortFields: Record<Order, number> = {
  relevance: 2,
  trending: 2,
  downloads: 6,
  updated: 3,
  name: 4,
};

interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary?: string;
  links?: Record<string, string | null>;
  authors?: { name: string }[];
  categories?: { id: number; name: string }[];
  downloadCount?: number;
  dateModified?: string;
  dateReleased?: string;
  latestFiles?: {
    id: number;
    displayName?: string;
    fileDate?: string;
    releaseType: number;
    gameVersions?: string[];
    sortableGameVersions?: { gameVersionTypeId: number }[];
    modules?: { name: string }[];
  }[];
  latestFilesIndexes?: {
    gameVersion: string;
    fileId: number;
    releaseType: number;
    gameVersionTypeId?: number;
  }[];
}

// A key the official API rejects (401 or 403) falls back to the mirror, as no key would.
async function get<T>(ctx: Context, path: string, signal?: AbortSignal): Promise<T> {
  const credentials = await getCredentials(ctx);
  if (credentials.curseforge) {
    try {
      return await requestJson<T>(`${OFFICIAL}${path}`, { credentials, signal });
    } catch (error) {
      if (!(error instanceof WowaddonError) || !["HTTP_401", "HTTP_403"].includes(error.code))
        throw error;
    }
  }
  return requestJson<T>(`${CURSE_TOOLS}${path}`, { signal });
}

const typeIds = (mod: CfMod): number[] => [
  ...(mod.latestFilesIndexes ?? []).map((index) => index.gameVersionTypeId ?? 0),
  ...(mod.latestFiles ?? []).flatMap((file) =>
    (file.sortableGameVersions ?? []).map((v) => v.gameVersionTypeId),
  ),
];
export function cfFlavors(mod: CfMod): Flavor[] {
  const ids = typeIds(mod);
  return flavorList((flavor) => ids.includes(flavors[flavor].cfType));
}

function validMod(mod: CfMod): boolean {
  return Number.isSafeInteger(mod?.id) && typeof mod.name === "string";
}
export function cfListing(mod: CfMod): Listing {
  return {
    ref: `cf:${mod.id}`,
    kind: "cf",
    name: mod.name,
    summary: mod.summary ?? "",
    authors: (mod.authors ?? []).map((author) => author.name),
    downloads: mod.downloadCount ?? null,
    updated: mod.dateReleased ?? mod.dateModified ?? null,
    categories: (mod.categories ?? []).map((category) => category.name),
    gameVersions: versionSort((mod.latestFilesIndexes ?? []).map((index) => index.gameVersion)),
    flavors: cfFlavors(mod),
    url: mod.links?.websiteUrl ?? `https://www.curseforge.com/wow/addons/${mod.slug}`,
  };
}

export async function cfCategories(ctx: Context, signal?: AbortSignal): Promise<Category[]> {
  const response = await get<{ data: { id: number; name: string; parentCategoryId?: number }[] }>(
    ctx,
    `/categories?gameId=${WOW}&classId=${ADDONS}`,
    signal,
  );
  if (!Array.isArray(response.data))
    throw new WowaddonError("SOURCE_RESPONSE", "Invalid CurseForge categories response.");
  const names = new Map(response.data.map((category) => [category.id, category.name]));
  return response.data
    .map((category) => ({
      kind: "cf" as const,
      id: String(category.id),
      name: category.name,
      ...(category.parentCategoryId && names.has(category.parentCategoryId)
        ? { parent: names.get(category.parentCategoryId) }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function cfSearch(
  ctx: Context,
  query: Query,
  signal?: AbortSignal,
): Promise<Listing[]> {
  const params = new URLSearchParams({
    gameId: String(WOW),
    classId: String(ADDONS),
    sortField: String(sortFields[query.order]),
    sortOrder: query.order === "name" ? "asc" : "desc",
    index: String((query.page - 1) * query.limit),
    pageSize: String(query.limit),
  });
  if (query.text) params.set("searchFilter", query.text);
  if (!query.allFlavors) params.set("gameVersionTypeId", String(flavors[ctx.flavor].cfType));
  if (query.category) {
    const category = matchCategory(await cfCategories(ctx, signal), query.category);
    if (!category)
      throw new WowaddonError("CATEGORY", `CurseForge has no category named ${query.category}.`);
    params.set("categoryId", category.id);
  }
  const response = await get<{ data: CfMod[] }>(ctx, `/mods/search?${params}`, signal);
  if (!Array.isArray(response.data))
    throw new WowaddonError("SOURCE_RESPONSE", "Invalid CurseForge search response.");
  return response.data.filter(validMod).map(cfListing);
}

// The newest file for this flavor, preferring a release over a beta or alpha.
function latestFile(mod: CfMod, flavor: Flavor) {
  const indexes = (mod.latestFilesIndexes ?? [])
    .filter((index) => index.gameVersionTypeId === flavors[flavor].cfType)
    .sort((a, b) => a.releaseType - b.releaseType || b.fileId - a.fileId);
  const id = indexes[0]?.fileId;
  return id === undefined
    ? undefined
    : { id, file: (mod.latestFiles ?? []).find((file) => file.id === id) };
}

interface Widget {
  id: number;
  title: string;
  summary?: string;
  urls?: { curseforge?: string };
  downloads?: { total?: number };
  categories?: string[];
  members?: { username: string }[];
  files?: {
    id: number;
    display?: string;
    type?: string;
    versions?: string[];
    uploaded_at?: string;
  }[];
}
// cfwidget carries most of a project page when the API mirror is down, but no links or folders.
function fromWidget(widget: Widget, flavor: Flavor): { mod: CfMod; fileId?: number } {
  const own = (widget.files ?? [])
    .filter((file) => (file.versions ?? []).some((v) => flavors[flavor].version.test(v)))
    .sort((a, b) => Number(a.type !== "release") - Number(b.type !== "release") || b.id - a.id)[0];
  const files = widget.files ?? [];
  return {
    fileId: own?.id,
    mod: {
      id: widget.id,
      name: widget.title,
      slug: "",
      summary: widget.summary,
      links: { websiteUrl: widget.urls?.curseforge ?? null },
      authors: (widget.members ?? []).map((member) => ({ name: member.username })),
      categories: (widget.categories ?? []).map((name, id) => ({ id, name })),
      downloadCount: widget.downloads?.total,
      dateReleased: files[0]?.uploaded_at,
      latestFiles: own ? [{ id: own.id, displayName: own.display, releaseType: 1 }] : [],
      latestFilesIndexes: unique(files.flatMap((file) => file.versions ?? [])).map((version) => {
        const match = flavorList((f) => flavors[f].version.test(version))[0];
        return {
          gameVersion: version,
          fileId: 0,
          releaseType: 1,
          gameVersionTypeId: match ? flavors[match].cfType : undefined,
        };
      }),
    },
  };
}

export async function cfInfo(ctx: Context, ref: string, signal?: AbortSignal): Promise<AddonInfo> {
  const { id } = await resolveCfProject(ctx, ref, signal);
  let mod: CfMod;
  let description = "";
  let fileId: number | undefined;
  let folders: string[] = [];
  try {
    mod = (await get<{ data: CfMod }>(ctx, `/mods/${id}`, signal)).data;
    if (!validMod(mod)) throw new WowaddonError("SOURCE_RESPONSE", "Invalid CurseForge project.");
    const file = latestFile(mod, ctx.flavor);
    fileId = file?.id;
    folders = (file?.file?.modules ?? []).map((module) => module.name);
    description = await get<{ data: string }>(ctx, `/mods/${id}/description`, signal)
      .then((response) => (typeof response.data === "string" ? htmlToText(response.data) : ""))
      .catch(() => "");
  } catch (error) {
    if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
    const widget = await requestJson<Widget>(`https://api.cfwidget.com/wow/addons/${id}`, {
      signal,
    });
    if (!Number.isSafeInteger(widget?.id) || typeof widget.title !== "string")
      throw new WowaddonError("SOURCE_RESPONSE", "Invalid CurseForge project.");
    ({ mod, fileId } = fromWidget(widget, ctx.flavor));
  }
  const file = mod.latestFiles?.find((candidate) => candidate.id === fileId);
  const changelog =
    fileId === undefined
      ? null
      : await requestJson<{ changelogBody?: string }>(
          `https://www.curseforge.com/api/v1/mods/${id}/files/${fileId}/change-log`,
          { signal, browser: true },
        )
          .then((response) =>
            typeof response.changelogBody === "string"
              ? {
                  version: file?.displayName ?? null,
                  text: firstLines(htmlToText(response.changelogBody), 2000),
                }
              : null,
          )
          .catch((error) => {
            if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
            return null;
          });
  const links = Object.fromEntries(
    Object.entries({
      website: mod.links?.websiteUrl,
      source: mod.links?.sourceUrl,
      issues: mod.links?.issuesUrl,
      wiki: mod.links?.wikiUrl,
    }).filter((pair): pair is [string, string] => typeof pair[1] === "string" && !!pair[1]),
  );
  return {
    ...cfListing(mod),
    version: file?.displayName ?? null,
    links,
    folders,
    description: firstLines(description || mod.summary || "", 1500),
    changelog,
  };
}
