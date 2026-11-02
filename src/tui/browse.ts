import type { Order } from "../discover/query";
import type { AddonInfo, Listing, SourceReport } from "../types";

// The browse view's state, kept apart from the installed list so switching views keeps both
// cursors, and so the scroll position (worked out from the cursor) comes back as it was.
export interface BrowseState {
  query: string;
  input: string;
  typing: boolean;
  order: Order;
  page: number;
  results: Listing[];
  sources: SourceReport[];
  loaded: boolean;
  loading: boolean;
  folded: Record<string, boolean>;
  cursor: number;
  info?: AddonInfo;
  infoLoading?: string;
  infoError?: string;
}

export const PAGE_LIMIT = 50;
// A category with more results than this starts folded, as keeper's groups do.
export const GROUP_FOLD_AT = 20;
const UNCATEGORISED = "Uncategorised";

export function initBrowse(): BrowseState {
  return {
    query: "",
    input: "",
    typing: false,
    order: "trending",
    page: 1,
    results: [],
    sources: [],
    loaded: false,
    loading: false,
    folded: {},
    cursor: 0,
  };
}

// Relevance only means something for a typed search, so browsing without one skips it.
export function nextOrder(browse: BrowseState): Order {
  const orders: Order[] = browse.query
    ? ["relevance", "downloads", "updated", "name"]
    : ["trending", "downloads", "updated", "name"];
  return orders[(orders.indexOf(browse.order) + 1) % orders.length] ?? orders[0];
}
export const ORDER_LABEL: Record<Order, string> = {
  relevance: "best match",
  trending: "trending",
  downloads: "most downloaded",
  updated: "recently updated",
  name: "by name",
};

export interface Group {
  name: string;
  items: Listing[];
  folded: boolean;
}
export type BrowseLine = { kind: "group"; group: Group } | { kind: "item"; listing: Listing };

// Results grouped by their first category, the biggest group first; each keeps the order the
// sources gave it, so a sort by downloads still reads top down inside a group.
export function groups(browse: BrowseState): Group[] {
  const byName = new Map<string, Listing[]>();
  for (const listing of browse.results) {
    const name = listing.categories[0] ?? UNCATEGORISED;
    byName.set(name, [...(byName.get(name) ?? []), listing]);
  }
  return [...byName.entries()]
    .map(([name, items]) => ({
      name,
      items,
      folded: browse.folded[name] ?? items.length > GROUP_FOLD_AT,
    }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}
export function browseLines(browse: BrowseState): BrowseLine[] {
  return groups(browse).flatMap((group) => [
    { kind: "group", group } as const,
    ...(group.folded ? [] : group.items.map((listing): BrowseLine => ({ kind: "item", listing }))),
  ]);
}

const clamp = (index: number, length: number) => Math.max(0, Math.min(index, length - 1));
export function cursorLine(browse: BrowseState): BrowseLine | undefined {
  const lines = browseLines(browse);
  return lines[clamp(browse.cursor, lines.length)];
}
export function selectedListing(browse: BrowseState): Listing | undefined {
  const line = cursorLine(browse);
  return line?.kind === "item" ? line.listing : undefined;
}
export function moveCursor(browse: BrowseState, delta: number): BrowseState {
  return { ...browse, cursor: clamp(browse.cursor + delta, browseLines(browse).length) };
}
export function cursorTo(browse: BrowseState, index: number): BrowseState {
  return { ...browse, cursor: clamp(index, browseLines(browse).length) };
}

// h folds the group under the cursor (from its header or any of its rows), l opens it, and
// enter on a header toggles it. The cursor lands on the header, which never moves on a fold.
export function setFold(browse: BrowseState, folded: boolean | "toggle"): BrowseState {
  const lines = browseLines(browse);
  const at = clamp(browse.cursor, lines.length);
  let header = at;
  while (header > 0 && lines[header]?.kind !== "group") header--;
  const line = lines[header];
  if (line?.kind !== "group") return browse;
  const value = folded === "toggle" ? !line.group.folded : folded;
  return {
    ...browse,
    folded: { ...browse.folded, [line.group.name]: value },
    cursor: header,
  };
}

export function startSearch(browse: BrowseState): BrowseState {
  return { ...browse, typing: true, input: browse.query };
}
export function cancelSearch(browse: BrowseState): BrowseState {
  return { ...browse, typing: false, input: browse.query };
}
// A submitted search starts at page one sorted by best match; an empty one goes back to trending.
export function submitSearch(browse: BrowseState): BrowseState {
  const query = browse.input.trim();
  return {
    ...browse,
    typing: false,
    query,
    order: query ? "relevance" : "trending",
    page: 1,
  };
}

export function loadingResults(browse: BrowseState): BrowseState {
  return { ...browse, loading: true };
}
export function setResults(
  browse: BrowseState,
  results: Listing[],
  sources: SourceReport[],
): BrowseState {
  return {
    ...browse,
    results,
    sources,
    loaded: true,
    loading: false,
    cursor: results.length ? 1 : 0,
    info: undefined,
    infoError: undefined,
  };
}
export function failedResults(browse: BrowseState, message: string): BrowseState {
  return {
    ...browse,
    loaded: true,
    loading: false,
    results: [],
    sources: [{ kind: "cf", status: "failed", count: 0, message }],
  };
}

// The sources that did not answer, in a few words for the status line.
export function sourceNotice(browse: BrowseState): string {
  return browse.sources
    .filter((source) => source.status !== "ok")
    .map((source) => `${source.kind} ${source.status}`)
    .join(" · ");
}

// The first visible row, worked out from the cursor alone, so leaving and coming back to a view
// at the same size shows the same rows.
export function windowStart(cursor: number, length: number, size: number): number {
  if (length <= size) return 0;
  return Math.max(0, Math.min(cursor - size + 1, length - size));
}
