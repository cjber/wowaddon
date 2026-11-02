import { expect, test } from "bun:test";
import type { Listing } from "../types";
import {
  browseLines,
  GROUP_FOLD_AT,
  groups,
  initBrowse,
  moveCursor,
  nextOrder,
  selectedListing,
  setFold,
  setResults,
  startSearch,
  submitSearch,
  windowStart,
} from "./browse";
import { keyLines } from "./model";

const listing = (name: string, category?: string): Listing => ({
  ref: `cf:${name}`,
  kind: "cf",
  name,
  summary: "",
  authors: [],
  downloads: null,
  updated: null,
  categories: category ? [category] : [],
  gameVersions: [],
  flavors: [],
  url: "",
});

test("results group by first category, biggest first, and a big group starts folded", () => {
  const many = Array.from({ length: GROUP_FOLD_AT + 1 }, (_, i) => listing(`Bag${i}`, "Bags"));
  const browse = setResults(initBrowse(), [listing("Map", "Map"), ...many, listing("Odd")], []);
  expect(groups(browse).map((g) => [g.name, g.items.length, g.folded])).toEqual([
    ["Bags", GROUP_FOLD_AT + 1, true],
    ["Map", 1, false],
    ["Uncategorised", 1, false],
  ]);
  expect(
    browseLines(browse).map((l) => (l.kind === "group" ? l.group.name : l.listing.name)),
  ).toEqual(["Bags", "Map", "Map", "Uncategorised", "Odd"]);
});

test("the cursor starts on the first result and h folds from any row onto its header", () => {
  let browse = setResults(initBrowse(), [listing("A", "X"), listing("B", "X")], []);
  expect(selectedListing(browse)?.name).toBe("A");
  browse = setFold(moveCursor(browse, 1), true);
  expect(browse.cursor).toBe(0);
  expect(browseLines(browse)).toHaveLength(1);
  expect(selectedListing(browse)).toBeUndefined();
  browse = setFold(browse, "toggle");
  expect(browseLines(browse)).toHaveLength(3);
  expect(moveCursor(browse, 99).cursor).toBe(2);
});

test("a search sorts by best match, an empty one goes back to trending, and o skips relevance without one", () => {
  let browse = startSearch(initBrowse());
  browse = submitSearch({ ...browse, input: "  map " });
  expect(browse).toMatchObject({ query: "map", order: "relevance", typing: false, page: 1 });
  expect(nextOrder(browse)).toBe("downloads");
  expect(nextOrder({ ...browse, order: "name" })).toBe("relevance");
  browse = submitSearch({ ...browse, input: "" });
  expect(browse.order).toBe("trending");
  expect(nextOrder({ ...browse, order: "name" })).toBe("trending");
});

test("the window follows the cursor alone and the keys line fits the longest key set", () => {
  expect(windowStart(3, 10, 20)).toBe(0);
  expect(windowStart(25, 40, 12)).toBe(14);
  expect(windowStart(39, 40, 12)).toBe(28);
  expect(keyLines(200)).toBe(1);
  expect(keyLines(100)).toBe(1);
  expect(keyLines(80)).toBe(2);
  expect(keyLines(40)).toBeGreaterThan(2);
});
