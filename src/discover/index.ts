import { checkAbort } from "../http";
import { parseRef } from "../refs";
import { resolveWago } from "../sources/wago";
import {
  type AddonInfo,
  type Category,
  type Context,
  type Listing,
  type SourceKind,
  type SourceReport,
  WowaddonError,
} from "../types";
import { cfCategories, cfInfo, cfSearch } from "./curseforge";
import { githubInfo, hubSearch } from "./github";
import { type Query, relevance } from "./query";
import { tukuiInfo, tukuiSearch } from "./tukui";
import { wowiCategories, wowiInfo, wowiSearch } from "./wowinterface";

export type { Query } from "./query";

type Searcher = (ctx: Context, query: Query, signal?: AbortSignal) => Promise<Listing[]>;
// Wago Addons serves its API only with a paid Patreon key and documents no search endpoint, so it
// is never searched; its addons are added by slug from the website.
export const WAGO_SEARCH =
  "Wago Addons has no keyless API, so it is not searched; add a Wago addon by its addons.wago.io URL or wago:<slug>.";
const searchers: Record<SourceKind, Searcher | undefined> = {
  cf: cfSearch,
  gh: hubSearch,
  wowi: wowiSearch,
  tukui: tukuiSearch,
  wago: undefined,
};
export const searchOrder: SourceKind[] = ["cf", "gh", "wowi", "tukui", "wago"];
// A source that cannot answer this query at all is skipped, not failed: the rest still answers.
const skipCodes = new Set(["NO_FLAVOR_TAG", "NO_CATEGORIES", "CATEGORY"]);

function merge(perSource: Listing[][], query: Query): Listing[] {
  const all = perSource.flat();
  if (query.order === "trending") {
    // Each source ranks trending its own way, so the merged list takes their rankings in turn.
    const turns: Listing[] = [];
    for (let rank = 0; turns.length < all.length; rank++)
      for (const list of perSource) if (list[rank]) turns.push(list[rank]);
    return turns;
  }
  const downloads = (a: Listing, b: Listing) => (b.downloads ?? -1) - (a.downloads ?? -1);
  const sorts: Record<Exclude<Query["order"], "trending">, (a: Listing, b: Listing) => number> = {
    relevance: (a, b) =>
      relevance(b.name, query.text) - relevance(a.name, query.text) || downloads(a, b),
    downloads,
    updated: (a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  };
  return all.sort(sorts[query.order]);
}

export async function discover(
  ctx: Context,
  query: Query,
  opts: { sources?: SourceKind[]; signal?: AbortSignal } = {},
): Promise<{ results: Listing[]; sources: SourceReport[] }> {
  const kinds = searchOrder.filter((kind) => !opts.sources?.length || opts.sources.includes(kind));
  const settled = await Promise.all(
    kinds.map(async (kind): Promise<[SourceReport, Listing[]]> => {
      const search = searchers[kind];
      if (!search) return [{ kind, status: "skipped", count: 0, message: WAGO_SEARCH }, []];
      try {
        const found = await search(ctx, query, opts.signal);
        return [{ kind, status: "ok", count: found.length }, found];
      } catch (error) {
        checkAbort(opts.signal);
        if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
        const code = error instanceof WowaddonError ? error.code : "ERROR";
        const message = error instanceof Error ? error.message : String(error);
        return [
          { kind, status: skipCodes.has(code) ? "skipped" : "failed", count: 0, code, message },
          [],
        ];
      }
    }),
  );
  return {
    results: merge(
      settled.map(([, found]) => found),
      query,
    ).slice(0, query.limit),
    sources: settled.map(([report]) => report),
  };
}

export async function categories(
  ctx: Context,
  signal?: AbortSignal,
): Promise<{ categories: Category[]; sources: SourceReport[] }> {
  const listers: [SourceKind, typeof cfCategories][] = [
    ["cf", cfCategories],
    ["wowi", wowiCategories],
  ];
  const found = await Promise.all(
    listers.map(async ([kind, list]): Promise<[SourceReport, Category[]]> => {
      try {
        const items = await list(ctx, signal);
        return [{ kind, status: "ok", count: items.length }, items];
      } catch (error) {
        checkAbort(signal);
        const code = error instanceof WowaddonError ? error.code : "ERROR";
        const message = error instanceof Error ? error.message : String(error);
        return [{ kind, status: "failed", count: 0, code, message }, []];
      }
    }),
  );
  const none = (kind: SourceKind, message: string): SourceReport => ({
    kind,
    status: "skipped",
    count: 0,
    message,
  });
  return {
    categories: found.flatMap(([, items]) => items),
    sources: [
      ...found.map(([report]) => report),
      none("gh", "WowUp Hub has no categories for GitHub addons."),
      none("tukui", "Tukui has no categories."),
      none("wago", WAGO_SEARCH),
    ],
  };
}

async function wagoInfo(ctx: Context, slug: string, signal?: AbortSignal): Promise<AddonInfo> {
  // resolveWago fails with WAGO_KEY_MISSING without the paid key; the API gives only the release.
  const release = await resolveWago(ctx, slug, signal);
  const url = `https://addons.wago.io/addons/${slug}`;
  return {
    ref: `wago:${slug}`,
    kind: "wago",
    name: slug,
    summary: "",
    authors: [],
    downloads: null,
    updated: null,
    categories: [],
    gameVersions: [],
    flavors: [ctx.flavor],
    url,
    version: release.version,
    links: { website: url },
    folders: [],
    description: "",
    changelog: null,
  };
}

const infos: Record<
  SourceKind,
  (ctx: Context, ref: string, signal?: AbortSignal) => Promise<AddonInfo>
> = { cf: cfInfo, wowi: wowiInfo, gh: githubInfo, tukui: tukuiInfo, wago: wagoInfo };

export async function addonInfo(
  ctx: Context,
  input: string,
  signal?: AbortSignal,
): Promise<AddonInfo> {
  const { kind, ref } = parseRef(input);
  return infos[kind](ctx, ref, signal);
}

// What each source can and cannot do next to its website, for --help, schema and the README.
export const sourceNotes: Record<SourceKind, { via: string; gaps: string }> = {
  cf: {
    via: "CurseForge's v1 API: api.curseforge.com with CF_API_KEY, else the keyless api.curse.tools mirror; changelogs from www.curseforge.com",
    gaps: "none for search, sorts, categories and details; screenshots and comments are not shown",
  },
  gh: {
    via: "WowUp Hub's index of GitHub addons that publish packaged releases, plus the GitHub API for info",
    gaps: "no categories; trending is the Hub's featured list; repos without packaged releases are not indexed, so add those by URL",
  },
  wowi: {
    via: "WoWInterface's file list, cached for six hours and searched locally",
    gaps: "no WoW: Forever compatibility tag, so Forever search skips it unless --all-flavors; listings carry no summary until info",
  },
  tukui: {
    via: "the Tukui API, which lists ElvUI and Tukui only",
    gaps: "no download counts and no categories",
  },
  wago: {
    via: "not searched",
    gaps: "Wago's API needs a paid Patreon key and documents no search; add by URL or wago:<slug>, and info needs WAGO_ADDONS_API_KEY",
  },
};
