import { getCredentials, requestJson } from "../http";
import { firstLines, htmlToText, markdownToText } from "../text";
import { type AddonInfo, type Context, type Flavor, type Listing, WowaddonError } from "../types";
import { flavorList, type Query, relevance, unique, versionSort } from "./query";

// GitHub addons are found through WowUp Hub (hub.wowup.io), WowUp's own index of GitHub repos that
// publish packaged releases with a release.json. It searches by name, lists featured and recently
// released addons per game type, and reports each release's game versions and download counts.
// It has no categories and no download-sorted search, so those sorts run on the page it returns.
export const HUB = "https://hub.wowup.io";
const gameTypes: Record<Flavor, string> = { era: "classic", forever: "forever" };

interface HubAddon {
  id: number;
  repository: string;
  repository_name: string;
  description?: string | null;
  owner_name?: string;
  total_download_count?: number;
  topics?: string[];
  releases?: {
    published_at?: string;
    tag_name?: string;
    game_type?: string;
    toc_title?: string | null;
    game_versions?: { game_type?: string; interface?: string; authors?: string | null }[];
    addonFolders?: { folder_name: string }[];
  }[];
}

const repoOf = (url: string) =>
  /^https:\/\/github\.com\/([a-z0-9-]+\/[a-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url)?.[1];
function hubFlavors(addon: HubAddon): Flavor[] {
  const types = (addon.releases ?? []).flatMap((release) => [
    release.game_type,
    ...(release.game_versions ?? []).map((version) => version.game_type),
  ]);
  return flavorList((flavor) => types.includes(gameTypes[flavor]));
}
export function hubListing(addon: HubAddon): Listing | undefined {
  const repo = repoOf(addon.repository ?? "");
  if (!repo) return undefined;
  const release = addon.releases?.[0];
  const versions = release?.game_versions ?? [];
  const authors = versions.find((version) => version.authors)?.authors;
  return {
    ref: `gh:${repo.toLowerCase()}`,
    kind: "gh",
    // A TOC title often ends in its version, which the listing already carries.
    name: (release?.toc_title || addon.repository_name).replace(/\s+v?\d+(?:\.\d+)+\S*$/i, ""),
    summary:
      htmlToText(addon.description ?? "")
        .split("\n")
        .find(Boolean)
        ?.slice(0, 200) ?? "",
    authors: authors ? [authors] : addon.owner_name ? [addon.owner_name] : [],
    downloads: addon.total_download_count ?? null,
    updated: release?.published_at ?? null,
    categories: [],
    gameVersions: versionSort(
      versions.flatMap((version) =>
        Number(version.interface) > 0 ? [version.interface ?? ""] : [],
      ),
    ),
    flavors: hubFlavors(addon),
    url: addon.repository,
  };
}
function listings(addons: unknown): Listing[] {
  if (!Array.isArray(addons))
    throw new WowaddonError("SOURCE_RESPONSE", "WowUp Hub returned an invalid addon list.");
  return addons.flatMap((addon) => hubListing(addon) ?? []);
}

export async function hubSearch(
  ctx: Context,
  query: Query,
  signal?: AbortSignal,
): Promise<Listing[]> {
  if (query.category)
    throw new WowaddonError("NO_CATEGORIES", "WowUp Hub has no categories for GitHub addons.");
  const wanted = query.page * query.limit;
  const type = gameTypes[ctx.flavor];
  let found: Listing[];
  if (query.text) {
    const response = await requestJson<{ addons?: unknown }>(
      `${HUB}/addons/search/${type}?query=${encodeURIComponent(query.text)}&limit=${wanted}`,
      { signal },
    );
    found = listings(response.addons);
  } else {
    const response = await requestJson<{ addons?: unknown; recent?: unknown }>(
      `${HUB}/addons/featured/${type}?count=${wanted}`,
      { signal },
    );
    found = listings(query.order === "updated" ? response.recent : response.addons);
  }
  const order: Partial<Record<Query["order"], (a: Listing, b: Listing) => number>> = {
    relevance: (a, b) => relevance(b.name, query.text) - relevance(a.name, query.text),
    downloads: (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
    updated: (a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  const sort = order[query.order];
  if (sort) found.sort(sort);
  return found.slice((query.page - 1) * query.limit, wanted);
}

interface Repo {
  full_name: string;
  description?: string | null;
  html_url: string;
  homepage?: string | null;
  owner?: { login: string };
  topics?: string[];
  pushed_at?: string;
}
interface Release {
  tag_name: string;
  published_at?: string;
  html_url?: string;
  body?: string | null;
  assets?: { name: string; download_count?: number }[];
}
// A GitHub addon's page: the repo and its latest release from the GitHub API, with the game
// versions and downloads WowUp Hub records when it indexes the repo.
export async function githubInfo(
  ctx: Context,
  repo: string,
  signal?: AbortSignal,
): Promise<AddonInfo> {
  const options = { credentials: await getCredentials(ctx), signal };
  const api = `https://api.github.com/repos/${repo}`;
  const project = await requestJson<Repo>(api, options);
  if (typeof project?.full_name !== "string" || typeof project.html_url !== "string")
    throw new WowaddonError("SOURCE_RESPONSE", "GitHub returned an invalid repository.");
  const notFound = (error: unknown) => {
    if (error instanceof WowaddonError && error.code === "HTTP_404") return undefined;
    throw error;
  };
  const release = await requestJson<Release>(`${api}/releases/latest`, options).catch(notFound);
  const name = project.full_name.split("/")[1];
  const hub = await requestJson<{ addons?: HubAddon[] }>(
    `${HUB}/addons/search/${gameTypes[ctx.flavor]}?query=${encodeURIComponent(name)}&limit=20`,
    { signal },
  )
    .then((response) =>
      (response.addons ?? []).find(
        (addon) => repoOf(addon.repository ?? "")?.toLowerCase() === repo.toLowerCase(),
      ),
    )
    .catch((error) => {
      if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
      return undefined;
    });
  const listed = hub && hubListing(hub);
  const releaseDownloads = release?.assets?.reduce((sum, a) => sum + (a.download_count ?? 0), 0);
  const links: Record<string, string> = { website: project.html_url, source: project.html_url };
  links.issues = `${project.html_url}/issues`;
  if (project.homepage) links.homepage = project.homepage;
  return {
    ref: `gh:${repo.toLowerCase()}`,
    kind: "gh",
    name: listed?.name ?? name,
    summary: project.description ?? listed?.summary ?? "",
    authors: listed?.authors ?? (project.owner ? [project.owner.login] : []),
    downloads: listed?.downloads ?? releaseDownloads ?? null,
    updated: release?.published_at ?? project.pushed_at ?? null,
    categories: project.topics ?? [],
    gameVersions: listed?.gameVersions ?? [],
    flavors: listed?.flavors ?? [],
    url: project.html_url,
    version: release?.tag_name ?? null,
    links,
    folders: hub?.releases?.[0]?.addonFolders?.map((folder) => folder.folder_name) ?? [],
    description: project.description ?? "",
    changelog: release?.body
      ? { version: release.tag_name, text: firstLines(markdownToText(release.body), 2000) }
      : null,
  };
}
