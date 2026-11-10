import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CURSE_TOOLS } from "./discover/curseforge";
import { HUB } from "./discover/github";
import { setFetch } from "./http";
import { manifestPath } from "./manifest";
import { adoptAddons, listUntracked } from "./service";
import { readState } from "./state";
import { json, offline, routeFetch, tempContext, zip } from "./testing/helpers";
import { readWowup, wowupRef } from "./wowup";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  offline();
  fixture = await tempContext("forever");
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});

async function addon(folder: string, toc: string) {
  await mkdir(join(fixture.ctx.addonsDir, folder), { recursive: true });
  await writeFile(join(fixture.ctx.addonsDir, folder, `${folder}.toc`), toc);
}
// Shaped like WowUp-CF's own files: installs in preferences.json, addons keyed by a UUID.
async function wowupData(location: string, label = "World of Warcraft: Forever") {
  const dir = join(fixture.root, "config", "WowUpCf");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "preferences.json"),
    JSON.stringify({ wow_installations: [{ id: "install-1", label, location }] }),
  );
  await writeFile(
    join(dir, "addons.json"),
    JSON.stringify({
      a: {
        name: "Auctionator",
        providerName: "Curse",
        externalId: "6124",
        installationId: "install-1",
        installedFolders: "Auctionator",
        installedVersion: "340",
      },
      b: {
        name: "Questie",
        providerName: "GitHub",
        externalId: "Questie/Questie",
        installationId: "install-1",
        installedFolders: "Questie,QuestieDB",
      },
      c: {
        name: "Elsewhere",
        providerName: "Curse",
        externalId: "1",
        installationId: "another-install",
        installedFolders: "Elsewhere",
      },
    }),
  );
  return dir;
}

test("WowUp's records for this flavor are found in the config folder and read only", async () => {
  const dir = await wowupData("/games/World of Warcraft/_classic_beta_/WowB.exe");
  const before = await readFile(join(dir, "addons.json"), "utf8");
  const data = await readWowup(fixture.ctx);
  expect(data).toMatchObject({ path: dir, installation: "World of Warcraft: Forever" });
  expect(data?.addons.map((a) => [a.name, a.folders])).toEqual([
    ["Auctionator", ["Auctionator"]],
    ["Questie", ["Questie", "QuestieDB"]],
  ]);
  expect(await readFile(join(dir, "addons.json"), "utf8")).toBe(before);
  const era = await tempContext("era");
  expect(await readWowup(era.ctx, dir)).toBeUndefined();
  await era.cleanup();
});

test("WowUp providers map to wowaddon refs, the Hub by its repository", async () => {
  setFetch(
    routeFetch({
      [`${HUB}/addons/47671`]: { addon: { repository: "https://github.com/Questie/Questie" } },
    }).fetch,
  );
  const record = (provider: string, externalId: string) => ({
    name: "x",
    provider,
    externalId,
    folders: [],
  });
  expect(await wowupRef(record("Curse", "6124"))).toEqual({ kind: "cf", ref: "6124" });
  expect(await wowupRef(record("GitHub", "Questie/Questie"))).toEqual({
    kind: "gh",
    ref: "questie/questie",
  });
  expect(await wowupRef(record("TukUI", "-2"))).toEqual({ kind: "tukui", ref: "elvui" });
  expect(await wowupRef(record("WowUpHub", "47671"))).toEqual({
    kind: "gh",
    ref: "questie/questie",
  });
  expect(await wowupRef(record("RaiderIO", "1"))).toEqual({
    reason: "WowUp provider RaiderIO has no wowaddon source",
  });
});

test("untracked folders leave out managed, dev and non-addon folders", async () => {
  await addon("Atlas", "## Title: |cff00ff00Atlas|r\n## X-Curse-Project-ID: 301");
  await mkdir(join(fixture.ctx.addonsDir, "Screenshots"));
  await mkdir(join(fixture.root, "dev", "MyAddon"), { recursive: true });
  await symlink(join(fixture.root, "dev", "MyAddon"), join(fixture.ctx.addonsDir, "MyAddon"));
  expect(await listUntracked(fixture.ctx)).toMatchObject([{ folder: "Atlas", title: "Atlas" }]);
});

test("a dry run matches folders by WowUp record, TOC ID, manifest line and title", async () => {
  await wowupData("/games/_forever_/Wow.exe");
  await addon("Auctionator", "## Title: Auctionator");
  await addon("Atlas", "## Title: Atlas\n## X-Curse-Project-ID: 301");
  await addon("RXPGuides", "## Title: RestedXP Guides\n## X-Curse-Project-ID: 486246");
  await addon("OpenMap", "## Title: OpenMap");
  await addon("Mystery", "## Title: Mystery");
  await mkdir(join(fixture.root, "config", "wowaddon"), { recursive: true });
  await writeFile(manifestPath(fixture.ctx), "gh restedxp/rxpguides\ncf 486246\n");
  const listing = (id: number, name: string) => ({
    id,
    name,
    slug: name.toLowerCase(),
    latestFilesIndexes: [
      { gameVersion: "1.60.1", fileId: id, releaseType: 1, gameVersionTypeId: 88568 },
    ],
    latestFiles: [{ id, displayName: "v1", releaseType: 1, modules: [{ name }] }],
  });
  const search = (text: string) =>
    `${CURSE_TOOLS}/mods/search?gameId=1&classId=1&sortField=2&sortOrder=desc&index=0&pageSize=10&searchFilter=${text}&gameVersionTypeId=88568`;
  const { fetch } = routeFetch({
    [`${CURSE_TOOLS}/mods/6124`]: { data: listing(6124, "Auctionator") },
    [`${CURSE_TOOLS}/mods/301`]: { data: listing(301, "Atlas") },
    [`${CURSE_TOOLS}/mods/486246`]: { data: listing(486246, "RestedXP Guides") },
    [`${CURSE_TOOLS}/mods/1735937`]: { data: listing(1735937, "OpenMap") },
    [search("OpenMap")]: { data: [listing(1735937, "OpenMap")] },
    [search("Mystery")]: { data: [listing(9, "Mystery Box")] },
    [`${HUB}/addons/search/forever?query=OpenMap&limit=10`]: { addons: [] },
    [`${HUB}/addons/search/forever?query=Mystery&limit=10`]: { addons: [] },
    "https://api.tukui.org/v1/addons": [],
  });
  setFetch(async (url, init) => {
    if (url.includes("/description") || url.includes("change-log")) return json({}, 404);
    return fetch(url, init);
  });
  const { plan, rows } = await adoptAddons(fixture.ctx, { dryRun: true });
  expect(rows).toEqual([]);
  expect(plan.wowup?.installation).toBe("World of Warcraft: Forever");
  expect(plan.matches.map((m) => [m.entry.id, m.matchedBy, m.inManifest, m.conflicts])).toEqual([
    ["cf:301", "toc", false, []],
    ["cf:1735937", "title", false, []],
    ["cf:486246", "toc", true, ["gh:restedxp/rxpguides"]],
    ["cf:6124", "wowup", false, []],
  ]);
  expect(plan.unmatched).toMatchObject([{ folder: "Mystery", title: "Mystery" }]);
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe(
    "gh restedxp/rxpguides\ncf 486246\n",
  );
});

test("a zero project ID falls through to the title search", async () => {
  await addon("OpenMap", "## Title: OpenMap\n## X-Curse-Project-ID: 0\n## X-WoWI-ID: 0");
  const listing = (id: number, name: string) => ({
    id,
    name,
    slug: name.toLowerCase(),
    latestFilesIndexes: [
      { gameVersion: "1.60.1", fileId: id, releaseType: 1, gameVersionTypeId: 88568 },
    ],
    latestFiles: [{ id, displayName: "v1", releaseType: 1, modules: [{ name }] }],
  });
  const search = (text: string) =>
    `${CURSE_TOOLS}/mods/search?gameId=1&classId=1&sortField=2&sortOrder=desc&index=0&pageSize=10&searchFilter=${text}&gameVersionTypeId=88568`;
  const { fetch, calls } = routeFetch({
    [`${CURSE_TOOLS}/mods/1735937`]: { data: listing(1735937, "OpenMap") },
    [search("OpenMap")]: { data: [listing(1735937, "OpenMap")] },
    [`${HUB}/addons/search/forever?query=OpenMap&limit=10`]: { addons: [] },
    "https://api.tukui.org/v1/addons": [],
  });
  setFetch(async (url, init) => {
    if (url.includes("/description") || url.includes("change-log")) return json({}, 404);
    return fetch(url, init);
  });
  const { plan } = await adoptAddons(fixture.ctx, { dryRun: true, wowup: false });
  expect(plan.matches.map((m) => [m.entry.id, m.matchedBy])).toEqual([["cf:1735937", "title"]]);
  // Project 0 is a placeholder, never a lookup: nothing is asked of CurseForge or WoWInterface for it.
  expect(calls.filter((url) => /\/(mods|addons)\/0(\?|$)/.test(url))).toEqual([]);
});

test("a manifest line that names the folder wins over a new one", async () => {
  await addon("RXPGuides", "## Title: RestedXP Guides\n## X-Curse-Project-ID: 486246");
  await mkdir(join(fixture.root, "config", "wowaddon"), { recursive: true });
  await writeFile(manifestPath(fixture.ctx), "gh restedxp/rxpguides\n");
  setFetch(async () => json({}, 404));
  const { plan } = await adoptAddons(fixture.ctx, { dryRun: true, wowup: false });
  expect(plan.matches.map((m) => [m.entry.id, m.matchedBy, m.inManifest])).toEqual([
    ["gh:restedxp/rxpguides", "manifest", true],
  ]);
});

test("adopt adds the matches and replaces their folders behind one WTF snapshot", async () => {
  await addon("Atlas", "## Title: Atlas\n## X-Curse-Project-ID: 301");
  await mkdir(join(fixture.root, "WTF"), { recursive: true });
  await writeFile(join(fixture.root, "WTF", "Config.wtf"), "SET x 1");
  const bytes = await zip({ "Atlas/Atlas.toc": "## Interface: 16001\n## Version: 2" });
  const files = {
    data: [
      {
        id: 7,
        projectId: 301,
        fileName: "Atlas-2.zip",
        displayName: "Atlas 2",
        dateCreated: "2026-11-01T00:00:00Z",
        gameVersionTypeIds: [88568],
        gameVersions: ["1.60.1"],
        releaseType: 1,
      },
    ],
    pagination: { totalCount: 1 },
  };
  const { fetch } = routeFetch({
    [`${CURSE_TOOLS}/mods/301`]: json({}, 404),
    "https://api.cfwidget.com/wow/addons/301": json({}, 404),
    "https://www.curseforge.com/api/v1/mods/301/files?pageIndex=0&pageSize=50&sort=dateCreated&sortDescending=true":
      files,
    "https://www.curseforge.com/api/v1/mods/301/files/7/dependencies?index=0&pageSize=50": {
      data: [],
      pagination: { index: 0, pageSize: 50, totalCount: 0 },
    },
    "https://www.curseforge.com/api/v1/mods/301/files/7/download": new Response(bytes),
  });
  setFetch(fetch);
  const { plan, rows, backup } = await adoptAddons(fixture.ctx, { wowup: false });
  expect(plan.matches.map((m) => m.entry.id)).toEqual(["cf:301"]);
  expect(rows.map((row) => [row.entry.id, row.status, row.installed?.version])).toEqual([
    ["cf:301", "current", "Atlas 2"],
  ]);
  expect(backup).toContain("WTF-");
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("cf 301\n");
  expect((await readState(fixture.ctx)).addons["cf:301"].folders).toEqual(["Atlas"]);
  expect(await readFile(join(fixture.ctx.addonsDir, "Atlas", "Atlas.toc"), "utf8")).toContain(
    "Version: 2",
  );
});
