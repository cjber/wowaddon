import { flavors } from "../flavors";
import { requestJson, requestText } from "../http";
import { firstLines, markdownToText } from "../text";
import { type AddonInfo, type Context, type Listing, WowaddonError } from "../types";
import { flavorList, type Query, relevance, versionSort, words } from "./query";

// Tukui lists two addons, ElvUI and Tukui, with no download counts or categories. One ZIP serves
// every client, and its Classic patch tag covers both Classic Era and WoW: Forever.
const API = "https://api.tukui.org/v1";
interface TukuiAddon {
  slug: string;
  name: string;
  author?: string;
  version?: string;
  last_update?: string;
  small_desc?: string;
  desc?: string;
  web_url?: string;
  git_url?: string;
  ticket_url?: string;
  donate_url?: string;
  changelog_url?: string;
  patch?: string[];
  directories?: string[];
}
const classic = /^1\.(13|14|15)(?:\.|$)/;
function tukuiListing(addon: TukuiAddon): Listing {
  const patches = addon.patch ?? [];
  return {
    ref: `tukui:${addon.slug}`,
    kind: "tukui",
    name: addon.name,
    summary: addon.small_desc ?? "",
    authors: addon.author ? [addon.author] : [],
    downloads: null,
    updated: addon.last_update ?? null,
    categories: [],
    gameVersions: versionSort([...patches]),
    flavors: flavorList((flavor) =>
      patches.some((patch) => classic.test(patch) || flavors[flavor].version.test(patch)),
    ),
    url: addon.web_url ?? `https://tukui.org/${addon.slug}`,
  };
}
const valid = (addon: TukuiAddon) =>
  typeof addon?.slug === "string" && typeof addon.name === "string";

export async function tukuiSearch(
  ctx: Context,
  query: Query,
  signal?: AbortSignal,
): Promise<Listing[]> {
  if (query.category) throw new WowaddonError("NO_CATEGORIES", "Tukui has no categories.");
  if (query.page > 1) return [];
  const addons = await requestJson<TukuiAddon[]>(`${API}/addons`, { signal });
  if (!Array.isArray(addons))
    throw new WowaddonError("SOURCE_RESPONSE", "Tukui returned an invalid addon list.");
  const wanted = words(query.text ?? "");
  return addons
    .filter(valid)
    .map(tukuiListing)
    .filter((listing) => query.allFlavors || listing.flavors.includes(ctx.flavor))
    .filter((listing) => wanted.every((word) => words(listing.name).join(" ").includes(word)))
    .sort((a, b) => relevance(b.name, query.text) - relevance(a.name, query.text))
    .slice(0, query.limit);
}

export async function tukuiInfo(
  _ctx: Context,
  slug: string,
  signal?: AbortSignal,
): Promise<AddonInfo> {
  const addon = await requestJson<TukuiAddon>(`${API}/addon/${slug}`, { signal });
  if (!valid(addon) || addon.slug !== slug)
    throw new WowaddonError("SOURCE_RESPONSE", "Tukui returned invalid addon details.");
  // The changelog is Markdown with the newest version first.
  const changelog = addon.changelog_url
    ? await requestText(addon.changelog_url, { signal }).catch((error) => {
        if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
        return "";
      })
    : "";
  const links = Object.fromEntries(
    Object.entries({
      website: addon.web_url,
      source: addon.git_url,
      issues: addon.ticket_url,
      donate: addon.donate_url,
    }).filter((pair): pair is [string, string] => typeof pair[1] === "string" && !!pair[1]),
  );
  return {
    ...tukuiListing(addon),
    version: addon.version ?? null,
    links,
    folders: addon.directories ?? [],
    description: firstLines(markdownToText(addon.desc ?? addon.small_desc ?? ""), 1500),
    changelog: changelog
      ? { version: addon.version ?? null, text: firstLines(markdownToText(changelog), 2000) }
      : null,
  };
}
