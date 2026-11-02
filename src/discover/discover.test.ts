import { afterEach, beforeEach, expect, test } from "bun:test";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setFetch } from "../http";
import changelog from "../testing/fixtures/cf-changelog-questie.json";
import widget from "../testing/fixtures/cfwidget-questie.json";
import categoriesFixture from "../testing/fixtures/ct-categories.json";
import description from "../testing/fixtures/ct-description-questie.json";
import mod from "../testing/fixtures/ct-mod-questie.json";
import search from "../testing/fixtures/ct-search-questie.json";
import release from "../testing/fixtures/github-questie-release.json";
import repo from "../testing/fixtures/github-questie-repo.json";
import featured from "../testing/fixtures/hub-featured.json";
import hubSearch from "../testing/fixtures/hub-search-questie.json";
import tukui from "../testing/fixtures/tukui-addons.json";
import wowiCategories from "../testing/fixtures/wowi-categorylist.json";
import wowiDetails from "../testing/fixtures/wowi-filedetails.json";
import wowiList from "../testing/fixtures/wowi-filelist.json";
import { json, offline, routeFetch, tempContext } from "../testing/helpers";
import { addonInfo, categories, discover } from ".";
import { CURSE_TOOLS } from "./curseforge";
import { HUB } from "./github";
import { matchCategory, type Query } from "./query";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  offline();
  fixture = await tempContext("forever");
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});
const query = (overrides: Partial<Query> = {}): Query => ({
  order: "relevance",
  limit: 20,
  page: 1,
  allFlavors: false,
  ...overrides,
});
const cfSearch = (params: string) => `${CURSE_TOOLS}/mods/search?gameId=1&classId=1&${params}`;
const WOWI = "https://api.mmoui.com/v3/game/WOW";

test("search asks every keyless source for this flavor and says why the rest are missing", async () => {
  const { fetch, calls } = routeFetch({
    [cfSearch(
      "sortField=2&sortOrder=desc&index=0&pageSize=20&searchFilter=questie&gameVersionTypeId=88568",
    )]: search,
    [`${HUB}/addons/search/forever?query=questie&limit=20`]: hubSearch,
    "https://api.tukui.org/v1/addons": tukui,
  });
  setFetch(fetch);
  const found = await discover(fixture.ctx, query({ text: "questie" }));
  expect(found.sources.map((s) => [s.kind, s.status, s.code])).toEqual([
    ["cf", "ok", undefined],
    ["gh", "ok", undefined],
    ["wowi", "skipped", "NO_FLAVOR_TAG"],
    ["tukui", "ok", undefined],
    ["wago", "skipped", undefined],
  ]);
  // Exact names first, then the most downloaded: CurseForge's Questie outranks the GitHub one.
  expect(found.results.slice(0, 2).map((l) => l.ref)).toEqual(["cf:334372", "gh:questie/questie"]);
  const hub = found.results.find((l) => l.ref === "gh:questie/questie");
  expect(hub).toMatchObject({ name: "Questie", flavors: ["era", "forever"], downloads: 4600659 });
  expect(found.results.find((l) => l.ref === "cf:334372")).toMatchObject({
    flavors: ["era", "forever"],
    categories: ["Quests & Leveling", "Map & Minimap", "Tooltip"],
    url: "https://www.curseforge.com/wow/addons/questie",
  });
  expect(calls.some((url) => url.includes("mmoui"))).toBe(false);
});

test("a CurseForge key the official API rejects falls back to the keyless mirror", async () => {
  const keyed = await tempContext("forever", { CF_API_KEY: "bad" });
  const ctx = keyed.ctx;
  const params = "sortField=6&sortOrder=desc&index=0&pageSize=5&gameVersionTypeId=88568";
  const { fetch, calls } = routeFetch({
    [`https://api.curseforge.com/v1/mods/search?gameId=1&classId=1&${params}`]: json(
      { error: "forbidden" },
      403,
    ),
    [cfSearch(params)]: search,
  });
  setFetch(fetch);
  const found = await discover(ctx, query({ order: "downloads", limit: 5 }), { sources: ["cf"] });
  expect(found.results.map((l) => l.ref)).toEqual(["cf:334372", "cf:1695789", "cf:1709717"]);
  expect(calls).toHaveLength(2);
  await keyed.cleanup();
});

test("one failing source is reported while the others still answer", async () => {
  setFetch(
    routeFetch({
      [`${HUB}/addons/featured/forever?count=20`]: featured,
    }).fetch,
  );
  const found = await discover(fixture.ctx, query({ order: "updated" }), {
    sources: ["cf", "gh"],
  });
  expect(found.sources[0]).toMatchObject({ kind: "cf", status: "failed", code: "HTTP_NETWORK" });
  // Recently updated reads the Hub's recent list, newest first.
  expect(found.results.map((l) => l.ref)).toEqual([
    "gh:questie/questie",
    "gh:darth-pie/foreversettings",
    "gh:mooreatv/mama-multiboxing",
  ]);
});

test("WoWInterface searches its cached file list for Classic Era, by category and sort", async () => {
  const era = await tempContext("era");
  const { fetch, calls } = routeFetch({
    [`${WOWI}/filelist.json`]: wowiList,
    [`${WOWI}/categorylist.json`]: wowiCategories,
  });
  setFetch(fetch);
  const map = await discover(era.ctx, query({ order: "trending", category: "map" }), {
    sources: ["wowi"],
  });
  expect(map.results.map((l) => [l.ref, l.categories[0]])).toEqual([
    ["wowi:7032", "Map, Coords, Compasses"],
    ["wowi:3896", "Map, Coords, Compasses"],
  ]);
  const named = await discover(era.ctx, query({ text: "atlas" }), { sources: ["wowi"] });
  expect(named.results.map((l) => l.ref)).toEqual(["wowi:3896"]);
  expect(named.results[0]).toMatchObject({ flavors: ["era"], authors: ["arith"] });
  // The second search reads the six-hour cache, not the 6 MB list again.
  expect(calls.filter((url) => url.endsWith("filelist.json"))).toHaveLength(1);
  await era.cleanup();
});

test("a stale WoWInterface cache still serves when the API is down", async () => {
  const era = await tempContext("era");
  const cache = join(era.ctx.configDir, "cache", "wowi-filelist.json");
  setFetch(
    routeFetch({ [`${WOWI}/filelist.json`]: wowiList, [`${WOWI}/categorylist.json`]: [] }).fetch,
  );
  await discover(era.ctx, query({ order: "name" }), { sources: ["wowi"] });
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await utimes(cache, old, old);
  offline();
  const found = await discover(era.ctx, query({ order: "name" }), { sources: ["wowi"] });
  expect(found.results.map((l) => l.name)).toEqual([
    "Atlas",
    "CTMod",
    "Deadly Boss Mods",
    "HealBot Continued",
    "TomTom",
  ]);
  await writeFile(cache, "not json");
  await utimes(cache, old, old);
  const broken = await discover(era.ctx, query({ order: "name" }), { sources: ["wowi"] });
  expect(broken.sources[0].status).toBe("failed");
  await era.cleanup();
});

test("sources without categories are skipped when a category is asked for", async () => {
  setFetch(
    routeFetch({
      [`${CURSE_TOOLS}/categories?gameId=1&classId=1`]: categoriesFixture,
      [cfSearch(
        "sortField=2&sortOrder=desc&index=0&pageSize=20&gameVersionTypeId=88568&categoryId=1011",
      )]: search,
    }).fetch,
  );
  const found = await discover(fixture.ctx, query({ order: "trending", category: "Map" }), {
    sources: ["cf", "gh", "tukui"],
  });
  expect(found.sources.map((s) => [s.kind, s.status, s.code])).toEqual([
    ["cf", "ok", undefined],
    ["gh", "skipped", "NO_CATEGORIES"],
    ["tukui", "skipped", "NO_CATEGORIES"],
  ]);
});

test("category names match exactly or as the one name containing the text", () => {
  const list = [
    { kind: "cf" as const, id: "1", name: "Map & Minimap" },
    { kind: "cf" as const, id: "2", name: "Mining" },
    { kind: "cf" as const, id: "3", name: "Bags & Inventory" },
  ];
  expect(matchCategory(list, "map minimap")?.id).toBe("1");
  expect(matchCategory(list, "bags")?.id).toBe("3");
  expect(matchCategory(list, "mi")).toBeUndefined();
});

test("categories lists CurseForge and WoWInterface and says which sources have none", async () => {
  setFetch(
    routeFetch({
      [`${CURSE_TOOLS}/categories?gameId=1&classId=1`]: categoriesFixture,
      [`${WOWI}/categorylist.json`]: wowiCategories,
    }).fetch,
  );
  const found = await categories(fixture.ctx);
  expect(found.categories.find((c) => c.name === "Mining")).toMatchObject({
    kind: "cf",
    parent: "Professions",
  });
  expect(found.categories.find((c) => c.kind === "wowi")).toMatchObject({ count: 321 });
  expect(found.sources.map((s) => s.status)).toEqual(["ok", "ok", "skipped", "skipped", "skipped"]);
});

test("CurseForge info reads the project, its description and this flavor's changelog", async () => {
  setFetch(
    routeFetch({
      [`${CURSE_TOOLS}/mods/334372`]: mod,
      [`${CURSE_TOOLS}/mods/334372/description`]: description,
      "https://www.curseforge.com/api/v1/mods/334372/files/9406949/change-log": changelog,
    }).fetch,
  );
  const info = await addonInfo(fixture.ctx, "cf:334372");
  expect(info).toMatchObject({
    ref: "cf:334372",
    name: "Questie",
    version: "v12.4.0",
    folders: ["Questie"],
    flavors: ["era", "forever"],
    links: {
      website: "https://www.curseforge.com/wow/addons/questie",
      source: "https://github.com/Questie/Questie",
    },
  });
  expect(info.changelog?.text).toStartWith("Questie 12.4.0\n\nBuild: f8938f4");
  expect(info.description).not.toContain("<");
});

test("CurseForge info falls back to cfwidget when the API mirror is down", async () => {
  setFetch(
    routeFetch({
      "https://api.cfwidget.com/wow/addons/334372": widget,
      "https://www.curseforge.com/api/v1/mods/334372/files/9334933/change-log": changelog,
    }).fetch,
  );
  const info = await addonInfo(fixture.ctx, "cf:334372");
  expect(info).toMatchObject({
    name: "Questie",
    authors: ["TheCrux_BB", "yttriumtyclief", "cheeq"],
    downloads: 210675712,
    version: "v12.3.1+v1.0.9",
    flavors: ["era", "forever"],
  });
  expect(info.changelog).not.toBeNull();
});

test("GitHub info joins the repo, its latest release and the Hub's game versions", async () => {
  setFetch(
    routeFetch({
      "https://api.github.com/repos/questie/questie": repo,
      "https://api.github.com/repos/questie/questie/releases/latest": release,
      [`${HUB}/addons/search/forever?query=Questie&limit=20`]: hubSearch,
    }).fetch,
  );
  const info = await addonInfo(fixture.ctx, "https://github.com/Questie/Questie");
  expect(info).toMatchObject({
    ref: "gh:questie/questie",
    version: "bundle/v12.4.0+v1.0.10",
    flavors: ["era", "forever"],
    downloads: 4600659,
    folders: ["Questie", "QuestieDB"],
    links: { issues: "https://github.com/Questie/Questie/issues" },
  });
  expect(info.changelog?.text).toStartWith("Questie 12.4.0");
});

test("WoWInterface info reads file details and the listing's compatibility", async () => {
  const era = await tempContext("era");
  setFetch(
    routeFetch({
      [`${WOWI}/filedetails/3896.json`]: wowiDetails,
      [`${WOWI}/filelist.json`]: wowiList,
      [`${WOWI}/categorylist.json`]: wowiCategories,
    }).fetch,
  );
  const info = await addonInfo(era.ctx, "wowi:3896");
  expect(info).toMatchObject({
    name: "Atlas",
    version: "v1.54.04",
    folders: ["Atlas"],
    categories: ["Map, Coords, Compasses"],
  });
  expect(info.description).not.toContain("[");
  await era.cleanup();
});

test("Tukui info carries ElvUI's folders and changelog for both flavors", async () => {
  const elvui = tukui.find((addon) => addon.slug === "elvui");
  setFetch(
    routeFetch({
      "https://api.tukui.org/v1/addon/elvui": elvui,
      "https://api.tukui.org/v1/changelog/elvui": new Response(
        "### Version 16.00\n* **Faster** loading",
      ),
    }).fetch,
  );
  const info = await addonInfo(fixture.ctx, "tukui:elvui");
  expect(info).toMatchObject({ flavors: ["era", "forever"], version: "16.00" });
  expect(info.changelog?.text).toBe("Version 16.00\n* Faster loading");
});

test("Wago info needs the paid key", async () => {
  await expect(addonInfo(fixture.ctx, "wago:plater")).rejects.toMatchObject({
    code: "WAGO_KEY_MISSING",
  });
});
