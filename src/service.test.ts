import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { CURSE_TOOLS } from "./discover/curseforge";
import { setFetch } from "./http";
import { manifestPath } from "./manifest";
import { addAddon, keyProblems, listRows, removeAddon, syncAddons } from "./service";
import { readState, writeState } from "./state";
import questieMod from "./testing/fixtures/ct-mod-questie.json";
import { json, offline, routeFetch, tempContext, zip } from "./testing/helpers";
import type { Progress } from "./types";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  offline();
  fixture = await tempContext();
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});
test("add without install writes canonical entry and duplicate is rejected", async () => {
  expect(
    (
      await addAddon(fixture.ctx, "https://github.com/Owner/Repo", {
        install: false,
        note: "My addon",
      })
    ).entry,
  ).toEqual({ id: "gh:owner/repo", kind: "gh", ref: "owner/repo", note: "My addon" });
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("gh owner/repo  # My addon\n");
  await expect(addAddon(fixture.ctx, "gh OWNER/REPO", { install: false })).rejects.toMatchObject({
    code: "DUPLICATE",
  });
  expect((await listRows(fixture.ctx, { refresh: false }))[0].status).toBe("missing");
});
test("CF slug writes numeric ID with title", async () => {
  setFetch(
    routeFetch({
      "https://api.cfwidget.com/wow/addons/auctionator": { id: 6124, title: "Auctionator" },
    }).fetch,
  );
  await addAddon(fixture.ctx, "auctionator", { install: false });
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("cf 6124  # Auctionator\n");
  await expect(addAddon(fixture.ctx, "6124", { install: false })).rejects.toMatchObject({
    code: "DUPLICATE",
  });
});
test("a refresh records the CurseForge key the API rejected while falling back", async () => {
  await writeFile(join(fixture.ctx.configDir, "cf_token"), "cf-secret");
  await writeFile(manifestPath(fixture.ctx), "cf 1708506\n");
  const calls: string[] = [];
  setFetch(async (url) => {
    calls.push(url);
    if (url.startsWith("https://www.curseforge.com/")) return new Response(null, { status: 403 });
    if (url.startsWith("https://api.curseforge.com/")) return new Response(null, { status: 403 });
    throw new Error(`Unexpected network request: ${url}`);
  });
  const rows = await listRows(fixture.ctx, { refresh: true });
  expect(rows[0].status).toBe("error");
  expect(calls.some((url) => url.startsWith("https://api.curseforge.com/"))).toBe(true);
  expect(await keyProblems(fixture.ctx)).toMatchObject([
    {
      source: "curseforge",
      status: 403,
      file: join(fixture.ctx.configDir, "cf_token"),
    },
  ]);
});
test("CF numeric ID writes the project title", async () => {
  setFetch(
    routeFetch({
      "https://api.cfwidget.com/wow/addons/298842": { id: 298842, title: "Leatrix Maps" },
    }).fetch,
  );
  await addAddon(fixture.ctx, "cf:298842", { install: false });
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("cf 298842  # Leatrix Maps\n");
});
test("CF numeric ID without a reachable title writes the bare ID", async () => {
  await addAddon(fixture.ctx, "cf:298842", { install: false });
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("cf 298842\n");
});
async function installRoutes() {
  const bytes = await zip({ "Foo/Foo_Forever.toc": "## Interface: 16001", "Foo/init.lua": "x" });
  const calls: string[] = [];
  setFetch(async (url) => {
    calls.push(url);
    if (url === "https://api.cfwidget.com/wow/addons/lost-addon") return json({}, 404);
    if (url === "https://api.github.com/repos/a/b/releases?per_page=100&page=1")
      return json([
        {
          tag_name: "v1",
          draft: false,
          prerelease: false,
          assets: [
            {
              id: 1,
              updated_at: "now",
              name: "Foo-forever.zip",
              browser_download_url: "https://github.com/a/b/asset.zip",
            },
          ],
        },
      ]);
    if (url === "https://github.com/a/b/asset.zip") return new Response(bytes);
    throw new Error(`Unexpected network request: ${url}`);
  });
  return calls;
}
async function devBuild(version: string, tag: string) {
  const target = join(fixture.root, "dev-build/Foo");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "Foo.toc"), `## Interface: 16001\n## Version: ${version}\n`);
  await writeFile(join(target, "marker"), "dev");
  await symlink(target, join(fixture.ctx.addonsDir, "Foo"));
  const bytes = await zip({ "Foo/Foo.toc": "## Interface: 16001", "Foo/marker": "new" });
  setFetch(async (url) => {
    if (url === "https://api.github.com/repos/a/foo/releases?per_page=100&page=1")
      return json([
        {
          tag_name: tag,
          draft: false,
          prerelease: false,
          assets: [
            {
              id: 1,
              updated_at: "now",
              name: "Foo-forever.zip",
              browser_download_url: "https://github.com/a/foo/asset.zip",
            },
          ],
        },
      ]);
    if (url === "https://github.com/a/foo/asset.zip") return new Response(bytes);
    throw new Error(`Unexpected network request: ${url}`);
  });
  await writeFile(manifestPath(fixture.ctx), "gh a/foo\n");
  return target;
}
test("add, local list, unchanged sync, and remove use the service contract", async () => {
  const calls = await installRoutes();
  const progress: Progress[] = [];
  const row = await addAddon(fixture.ctx, "a/b", {
    install: true,
    onProgress: (p) => progress.push(p),
  });
  expect(row.status).toBe("current");
  expect(progress.map((p) => p.phase)).toEqual(["resolving", "downloading", "installing", "done"]);
  // The release the install resolved is cached, so a local list knows it is current.
  expect((await listRows(fixture.ctx, { refresh: false }))[0].status).toBe("current");
  expect(calls).toHaveLength(2);
  expect((await syncAddons(fixture.ctx, { ids: ["https://github.com/A/B"] })).rows[0].message).toBe(
    "up to date",
  );
  expect(calls).toHaveLength(3);
  await removeAddon(fixture.ctx, "gh:A/B");
  expect((await readState(fixture.ctx)).addons).toEqual({});
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
});
test("the five Forever addons that bundle ForeverCore all sync and share it", async () => {
  const addons = [
    { id: 1705762, folder: "Tweaks Forever" },
    { id: 1708506, folder: "SkillUp Forever" },
    { id: 1705879, folder: "Legacy Forever" },
    { id: 1786835, folder: "Commissions" },
    { id: 1794367, folder: "Field Guide" },
  ];
  const routes: Record<string, unknown> = {};
  for (const { id, folder } of addons) {
    const fileId = id + 1_000_000;
    const bytes = await zip({
      "ForeverCore/ForeverCore.toc": "## Interface: 16001\n## Version: 2.0.2\n",
      "ForeverCore/marker": "core",
      [`${folder}/${folder}.toc`]: "## Interface: 16001\n## Version: 2.0.2\n",
      [`${folder}/marker`]: "addon",
    });
    routes[
      `https://www.curseforge.com/api/v1/mods/${id}/files?pageIndex=0&pageSize=50&sort=dateCreated&sortDescending=true`
    ] = {
      data: [
        {
          id: fileId,
          projectId: id,
          fileName: `${folder.replaceAll(" ", "")}.zip`,
          gameVersionTypeIds: [88568],
          gameVersions: ["1.60.0"],
          releaseType: 1,
          dateCreated: "2026-11-10",
        },
      ],
      pagination: { totalCount: 1 },
    };
    routes[
      `https://www.curseforge.com/api/v1/mods/${id}/files/${fileId}/dependencies?index=0&pageSize=50`
    ] = { data: [], pagination: { index: 0, pageSize: 50, totalCount: 0 } };
    routes[`https://www.curseforge.com/api/v1/mods/${id}/files/${fileId}/download`] = new Response(
      bytes,
    );
  }
  setFetch(routeFetch(routes).fetch);
  await writeFile(manifestPath(fixture.ctx), addons.map((addon) => `cf ${addon.id}\n`).join(""));
  const { rows } = await syncAddons(fixture.ctx, {});
  expect(rows.map((row) => row.status)).toEqual(Array(addons.length).fill("current"));
  expect(rows.every((row) => row.installed?.folders.includes("ForeverCore"))).toBe(true);
  const state = await readState(fixture.ctx);
  for (const { id } of addons) expect(state.addons[`cf:${id}`].folders).toContain("ForeverCore");
  expect(await readdir(fixture.ctx.addonsDir)).toContain("ForeverCore");
  expect(
    (await listRows(fixture.ctx, { refresh: false })).every(
      (row) => row.sharedFolders?.[0]?.folder === "ForeverCore",
    ),
  ).toBe(true);
  expect((await listRows(fixture.ctx, { refresh: false }))[0].sharedFolders?.[0]?.owners).toEqual(
    addons.map((addon) => `cf:${addon.id}`),
  );
});
test("an add stopped by an unmanaged folder leaves the manifest alone, so --adopt can retry it", async () => {
  await mkdir(join(fixture.ctx.addonsDir, "Foo"));
  await installRoutes();
  expect(await addAddon(fixture.ctx, "a/b", { install: true, dryRun: true })).toMatchObject({
    status: "unmanaged",
    code: "UNMANAGED",
  });
  expect(await addAddon(fixture.ctx, "a/b", { install: true })).toMatchObject({
    status: "unmanaged",
    code: "UNMANAGED",
  });
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
  expect(
    (await addAddon(fixture.ctx, "a/b", { install: true, adopt: true, dryRun: true })).status,
  ).toBe("missing");
  expect((await addAddon(fixture.ctx, "a/b", { install: true, adopt: true })).status).toBe(
    "current",
  );
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("gh a/b\n");
});
const questieFiles =
  "https://www.curseforge.com/api/v1/mods/334372/files?pageIndex=0&pageSize=50&sort=dateCreated&sortDescending=true";
const questieDependencies =
  "https://www.curseforge.com/api/v1/mods/334372/files/9/dependencies?index=0&pageSize=50";
const questieRoutes = {
  [questieFiles]: {
    data: [
      {
        id: 9,
        projectId: 334372,
        fileName: "Questie.zip",
        gameVersionTypeIds: [67408],
        gameVersions: ["1.15.8"],
        releaseType: 1,
      },
    ],
    pagination: { totalCount: 1 },
  },
  [questieDependencies]: { data: [], pagination: { index: 0, pageSize: 50, totalCount: 0 } },
};
async function checkStatus() {
  return (await listRows(fixture.ctx, { refresh: true })).map((row) => row.status);
}
const questieInfo = {
  [`${CURSE_TOOLS}/mods/334372`]: questieMod,
  [`${CURSE_TOOLS}/mods/334372/description`]: { data: "" },
};
test("check judges a missing addon from the cheapest evidence that settles it", async () => {
  fixture.ctx.flavor = "era";
  await writeFile(manifestPath(fixture.ctx), "cf 334372\n");
  const routes = routeFetch({ ...questieRoutes, ...questieInfo });
  setFetch(routes.fetch);
  // No untracked folder at all: missing, from the release alone.
  expect(await checkStatus()).toEqual(["missing"]);
  expect(routes.calls).toEqual([questieFiles, questieDependencies]);
  // An untracked folder the source does not list: missing, from its folder list.
  await mkdir(join(fixture.ctx.addonsDir, "Other"));
  routes.calls.length = 0;
  expect(await checkStatus()).toEqual(["missing"]);
  expect(routes.calls.some((url) => url.includes("/download"))).toBe(false);
  // A folder whose TOC carries the project ID: unmanaged, with no lookup beyond the release.
  await mkdir(join(fixture.ctx.addonsDir, "QuestieOld"));
  await writeFile(
    join(fixture.ctx.addonsDir, "QuestieOld/QuestieOld.toc"),
    "## X-Curse-Project-ID: 334372\n",
  );
  routes.calls.length = 0;
  const [row] = await listRows(fixture.ctx, { refresh: true });
  expect(row).toMatchObject({ status: "unmanaged", code: "UNMANAGED" });
  expect(routes.calls).toEqual([questieFiles, questieDependencies]);
});
test("check matches an untracked folder by the source's folder list, and a symlink is dev", async () => {
  fixture.ctx.flavor = "era";
  await writeFile(manifestPath(fixture.ctx), "cf 334372\n");
  const routes = routeFetch({ ...questieRoutes, ...questieInfo });
  setFetch(routes.fetch);
  await mkdir(join(fixture.ctx.addonsDir, "Questie"));
  expect(await checkStatus()).toEqual(["unmanaged"]);
  expect(routes.calls.some((url) => url.includes("/download"))).toBe(false);
  await rm(join(fixture.ctx.addonsDir, "Questie"), { recursive: true });
  await mkdir(join(fixture.root, "dev/Questie"), { recursive: true });
  await symlink(join(fixture.root, "dev/Questie"), join(fixture.ctx.addonsDir, "Questie"));
  expect(await checkStatus()).toEqual(["dev"]);
});
test("list keeps an unexpired dev build and names what it waits for", async () => {
  const target = await devBuild("v1.1.0-dev+3fa2c1d", "v1.1.0");
  expect((await listRows(fixture.ctx, { refresh: true }))[0]).toMatchObject({
    status: "dev",
    devTag: "v1.1.0",
    message: "dev build of v1.1.0, waiting for a newer release",
  });
  expect((await syncAddons(fixture.ctx, {})).rows[0]).toMatchObject({
    status: "dev",
    devTag: "v1.1.0",
  });
  expect((await lstat(join(fixture.ctx.addonsDir, "Foo"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(target, "marker"), "utf8")).toBe("dev");
});
test("sync replaces an expired dev build and leaves its target untouched", async () => {
  const target = await devBuild("v1.0.0-dev+3fa2c1d", "v1.1.0");
  expect((await listRows(fixture.ctx, { refresh: true }))[0]).toMatchObject({
    status: "update",
    devTag: "v1.0.0",
  });
  const [row] = (await syncAddons(fixture.ctx, {})).rows;
  expect(row).toMatchObject({
    status: "updated",
    devTag: "v1.0.0",
    installed: { version: "v1.1.0", versionKey: "1:now" },
  });
  expect(row.message).toBe("dev build of v1.0.0 replaced by v1.1.0");
  expect((await lstat(join(fixture.ctx.addonsDir, "Foo"))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(fixture.ctx.addonsDir, "Foo/marker"), "utf8")).toBe("new");
  expect(await readFile(join(target, "marker"), "utf8")).toBe("dev");
  expect(await readFile(join(target, "Foo.toc"), "utf8")).toContain("v1.0.0-dev+3fa2c1d");
});
test("sync --dry-run predicts an expired dev build without touching its link", async () => {
  const target = await devBuild("v1.0.0-dev+3fa2c1d", "v1.1.0");
  const [row] = (await syncAddons(fixture.ctx, { dryRun: true })).rows;
  expect(row).toMatchObject({ status: "update", devTag: "v1.0.0" });
  expect((await lstat(join(fixture.ctx.addonsDir, "Foo"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(target, "marker"), "utf8")).toBe("dev");
});
test("check downloads only when a folder named like the addon is otherwise undecided", async () => {
  await writeFile(manifestPath(fixture.ctx), "gh a/b  # Foo\n");
  await mkdir(join(fixture.ctx.addonsDir, "Foo"));
  const calls = await installRoutes();
  // installRoutes has no repository route, so the source lists no folders and the download decides.
  expect(await checkStatus()).toEqual(["unmanaged"]);
  expect(calls).toContain("https://github.com/a/b/asset.zip");
  expect((await syncAddons(fixture.ctx, { dryRun: true })).rows[0].status).toBe("unmanaged");
  expect(await readdir(join(fixture.ctx.addonsDir, "Foo"))).toEqual([]);
});
test("a failed add leaves the manifest as it was, so a rerun is not a duplicate", async () => {
  let online = false;
  const bytes = await zip({ "Foo/Foo.toc": "## Interface: 16001" });
  setFetch(async (url) => {
    if (!online) throw new TypeError("network down");
    if (url === "https://api.github.com/repos/a/b/releases?per_page=100&page=1")
      return json([
        {
          tag_name: "v1",
          draft: false,
          prerelease: false,
          assets: [
            {
              id: 1,
              updated_at: "now",
              name: "Foo-forever.zip",
              browser_download_url: "https://github.com/a/b/asset.zip",
            },
          ],
        },
      ]);
    if (url === "https://github.com/a/b/asset.zip") return new Response(bytes);
    throw new Error(`Unexpected network request: ${url}`);
  });
  expect((await addAddon(fixture.ctx, "a/b", { install: true })).status).toBe("error");
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
  expect((await readState(fixture.ctx)).addons).toEqual({});
  online = true;
  expect((await addAddon(fixture.ctx, "a/b", { install: true })).status).toBe("current");
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("gh a/b\n");
});
test("a sync dry run predicts an unmanaged folder like the real sync", async () => {
  await writeFile(manifestPath(fixture.ctx), "gh a/b\n");
  await mkdir(join(fixture.ctx.addonsDir, "Foo"));
  await installRoutes();
  const dry = await syncAddons(fixture.ctx, { dryRun: true });
  expect(dry).toEqual({ rows: [expect.objectContaining({ status: "unmanaged" })] });
  expect((await syncAddons(fixture.ctx, { dryRun: true, adopt: true })).rows[0].status).toBe(
    "missing",
  );
  expect((await readState(fixture.ctx)).addons).toEqual({});
  expect(await readdir(join(fixture.ctx.addonsDir, "Foo"))).toEqual([]);
  expect((await syncAddons(fixture.ctx, {})).rows[0].status).toBe("unmanaged");
  expect((await syncAddons(fixture.ctx, { adopt: true })).rows[0].status).toBe("current");
});
test("an add onto a symlinked folder says how to replace the link", async () => {
  await installRoutes();
  await mkdir(join(fixture.root, "dev/Foo"), { recursive: true });
  await symlink(join(fixture.root, "dev/Foo"), join(fixture.ctx.addonsDir, "Foo"));
  for (const dryRun of [true, false]) {
    const row = await addAddon(fixture.ctx, "a/b", { install: true, dryRun });
    expect(row.status).toBe("dev");
    expect(row.message).toContain("remove the symlink or checkout, then run sync");
  }
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("gh a/b\n");
  expect((await lstat(join(fixture.ctx.addonsDir, "Foo"))).isSymbolicLink()).toBe(true);
});
test("protected owned addon makes no metadata or download requests", async () => {
  await addAddon(fixture.ctx, "a/b", { install: false });
  await symlink(join(fixture.root, "missing-dev-folder"), join(fixture.ctx.addonsDir, "Foo"));
  const state = await readState(fixture.ctx);
  state.addons["gh:a/b"] = { version: "v1", versionKey: "1", installedAt: "now", folders: ["Foo"] };
  await writeState(fixture.ctx, state);
  expect((await syncAddons(fixture.ctx, {})).rows[0].status).toBe("dev");
  expect((await listRows(fixture.ctx, { refresh: true }))[0].status).toBe("dev");
  await removeAddon(fixture.ctx, "a/b");
  expect((await readState(fixture.ctx)).addons).toEqual({});
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
  expect((await lstat(join(fixture.ctx.addonsDir, "Foo"))).isSymbolicLink()).toBe(true);
});
test("cancelled mutation leaves manifest unchanged", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    addAddon(fixture.ctx, "a/b", { install: true, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "ABORTED" });
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
});
test("legacy CF local reads report uncached slugs on their row without network", async () => {
  await writeFile(manifestPath(fixture.ctx), "cf auctionator\n");
  expect((await listRows(fixture.ctx, { refresh: false }))[0]).toMatchObject({
    entry: { id: "cf:auctionator", ref: "auctionator" },
    status: "error",
    message: "Refresh to resolve legacy CurseForge name: auctionator",
  });
  await mkdir(join(fixture.ctx.configDir, "cache"));
  await writeFile(join(fixture.ctx.configDir, "cache/cf-slugs.json"), '{"auctionator":6124}');
  expect((await listRows(fixture.ctx, { refresh: false }))[0].entry.id).toBe("cf:6124");
});

test("a CF add with no build for the flavor fails and leaves the manifest alone", async () => {
  setFetch(
    routeFetch({
      "https://api.cfwidget.com/wow/addons/auctionator": { id: 6124, title: "Auctionator" },
      "https://www.curseforge.com/api/v1/mods/6124/files?pageIndex=0&pageSize=50&sort=dateCreated&sortDescending=true":
        {
          data: [
            {
              id: 5,
              projectId: 6124,
              fileName: "auctionator-classic.zip",
              gameVersionTypeIds: [67408],
              gameVersions: ["1.15.8"],
              releaseType: 1,
            },
          ],
          pagination: { totalCount: 1 },
        },
    }).fetch,
  );
  const row = await addAddon(fixture.ctx, "auctionator", { install: true });
  expect(row.status).toBe("error");
  expect(row.message).toBe("No Forever build on CurseForge (latest is Classic Era)");
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
});
test("WoWI archive TOCs enforce the selected flavor", async () => {
  const bytes = await zip({ "Foo/Foo.toc": "## Interface: 11508" });
  setFetch(async (url) => {
    if (url === "https://api.mmoui.com/v3/game/WOW/filedetails/123.json")
      return json([
        {
          UID: "123",
          UIDownload: "https://cdn.wowinterface.com/file.zip",
          UIDate: 1,
          UIVersion: "v1",
        },
      ]);
    expect(url).toBe("https://cdn.wowinterface.com/file.zip");
    return new Response(bytes);
  });
  const row = await addAddon(fixture.ctx, "wowi:123", { install: true });
  expect(row.status).toBe("error");
  expect(row.message).toContain("no compatible addon folders");
  expect((await readState(fixture.ctx)).addons).toEqual({});
});

test("unresolved CF rows do not block refresh, sync, add or remove of other entries", async () => {
  await writeFile(manifestPath(fixture.ctx), "cf lost-addon  # Keep me\ngh a/b\n");
  const calls = await installRoutes();
  const local = await listRows(fixture.ctx, { refresh: false });
  expect(local.map((row) => row.status)).toEqual(["error", "missing"]);
  expect(calls).toEqual([]);
  const refreshed = await listRows(fixture.ctx, { refresh: true });
  expect(refreshed[0]).toMatchObject({
    entry: { id: "cf:lost-addon", ref: "lost-addon", note: "Keep me" },
    status: "error",
    message: "Couldn't resolve that CurseForge name — paste the project URL or its numeric ID",
  });
  expect(refreshed[1].latest?.version).toBe("v1");
  expect((await syncAddons(fixture.ctx, { ids: ["a/b"] })).rows[0].status).toBe("current");
  expect((await syncAddons(fixture.ctx, {})).rows.map((row) => row.status)).toEqual([
    "error",
    "current",
  ]);
  await addAddon(fixture.ctx, "c/d", { install: false });
  await removeAddon(fixture.ctx, "a/b");
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe(
    "cf lost-addon  # Keep me\ngh c/d\n",
  );
});
for (const ref of [
  "lost-addon",
  "cf:lost-addon",
  "https://www.curseforge.com/wow/addons/lost-addon",
]) {
  test(`remove unresolved CF manifest line by ${ref}`, async () => {
    await writeFile(manifestPath(fixture.ctx), "cf lost-addon\ngh a/b\n");
    await removeAddon(fixture.ctx, ref);
    expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("gh a/b\n");
  });
}

test("cancelled removal leaves the manifest and installed folders intact", async () => {
  await installRoutes();
  await addAddon(fixture.ctx, "a/b", { install: true });
  const controller = new AbortController();
  controller.abort();
  await expect(
    removeAddon(fixture.ctx, "a/b", { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "ABORTED" });
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("gh a/b\n");
  expect(await readFile(join(fixture.ctx.addonsDir, "Foo/init.lua"), "utf8")).toBe("x");
});

test("a symlinked dev folder named after the repo is dev with no state record", async () => {
  await addAddon(fixture.ctx, "questie/questietrace", { install: false });
  await symlink(join(fixture.root, "checkout"), join(fixture.ctx.addonsDir, "QuestieTrace"));
  expect((await listRows(fixture.ctx, { refresh: false }))[0].status).toBe("dev");
  expect((await listRows(fixture.ctx, { refresh: true }))[0].status).toBe("dev");
  expect((await syncAddons(fixture.ctx, {})).rows[0].status).toBe("dev");
  expect((await readState(fixture.ctx)).addons).toEqual({});
});

test("dry runs report the change and leave manifest, state and folders alone", async () => {
  const calls = await installRoutes();
  const added = await addAddon(fixture.ctx, "a/b", { install: true, dryRun: true });
  expect(added).toMatchObject({ status: "missing", latest: { version: "v1" } });
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
  expect(await readdir(fixture.ctx.addonsDir)).toEqual([]);
  expect(calls).toHaveLength(2);
  await addAddon(fixture.ctx, "a/b", { install: true });
  const before = await readState(fixture.ctx);
  const removal = await removeAddon(fixture.ctx, "a/b", { dryRun: true });
  expect(removal).toMatchObject({ entry: { id: "gh:a/b" }, deleted: true });
  expect(await readState(fixture.ctx)).toEqual(before);
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("gh a/b\n");
  expect(await readFile(join(fixture.ctx.addonsDir, "Foo/init.lua"), "utf8")).toBe("x");
  expect((await removeAddon(fixture.ctx, "a/b")).deleted).toBe(true);
});

test("sync snapshots WTF once before its first change and keeps the newest backups", async () => {
  const wtf = join(fixture.root, "WTF");
  await mkdir(join(wtf, "Account/ME/SavedVariables"), { recursive: true });
  await writeFile(join(wtf, "Config.wtf"), "SET a 1");
  await writeFile(join(wtf, "Account/ME/SavedVariables/Foo.lua"), "Foo = {}");
  await writeFile(manifestPath(fixture.ctx), "gh a/b\n");
  await installRoutes();
  fixture.ctx.backups.keep = 2;
  const backups = fixture.ctx.backups.dir;
  expect(backups).toBe(join(fixture.root, ".local/state/wowaddon/backups/forever"));
  const first = await syncAddons(fixture.ctx, {});
  expect(first.rows[0].status).toBe("current");
  expect(first.backup).toStartWith(join(backups, "WTF-"));
  const entries = await new ZipReader(
    new Uint8ArrayReader(await readFile(first.backup ?? "")),
  ).getEntries();
  expect(entries.map((entry) => entry.filename).sort()).toEqual([
    "WTF/Account/ME/SavedVariables/Foo.lua",
    "WTF/Config.wtf",
  ]);
  // Up to date: nothing changes, so nothing is backed up.
  expect((await syncAddons(fixture.ctx, {})).backup).toBeUndefined();
  for (const name of ["WTF-2000-01-01T00-00-00-000Z.zip", "WTF-2000-01-02T00-00-00-000Z.zip"])
    await writeFile(join(backups, name), "old");
  await removeAddon(fixture.ctx, "a/b");
  await addAddon(fixture.ctx, "a/b", { install: false });
  const second = await syncAddons(fixture.ctx, {});
  expect((await readdir(backups)).sort()).toEqual(
    [first.backup, second.backup].map((path) => basename(path ?? "")).sort(),
  );
  await removeAddon(fixture.ctx, "a/b");
  await addAddon(fixture.ctx, "a/b", { install: false });
  const skipped = await syncAddons(fixture.ctx, { backup: false });
  expect(skipped.rows[0].status).toBe("current");
  expect(skipped.backup).toBeUndefined();
  expect(await readdir(backups)).toHaveLength(2);
});

test("a failed WTF backup fails every install and changes nothing", async () => {
  await mkdir(join(fixture.root, "WTF"));
  await writeFile(join(fixture.root, ".local"), "a file where the state directory should be");
  await writeFile(manifestPath(fixture.ctx), "gh a/b\n");
  await installRoutes();
  const result = await syncAddons(fixture.ctx, {});
  expect(result.rows[0]).toMatchObject({ status: "error", code: "BACKUP_FAILED" });
  expect(result.backup).toBeUndefined();
  expect(await readdir(fixture.ctx.addonsDir)).toEqual([]);
});

test("a bare name finds the one manifest entry with that ref, offline", async () => {
  await writeFile(manifestPath(fixture.ctx), "tukui elvui\ngh a/b\n");
  expect((await removeAddon(fixture.ctx, "ElvUI", { dryRun: true })).entry.id).toBe("tukui:elvui");
});

const cfFilesUrl = (id: number) =>
  `https://www.curseforge.com/api/v1/mods/${id}/files?pageIndex=0&pageSize=50&sort=dateCreated&sortDescending=true`;
const cfDependenciesUrl = (id: number, fileId: number) =>
  `https://www.curseforge.com/api/v1/mods/${id}/files/${fileId}/dependencies?index=0&pageSize=50`;
const cfDownloadUrl = (id: number, fileId: number) =>
  `https://www.curseforge.com/api/v1/mods/${id}/files/${fileId}/download`;
function cfFile(projectId: number, fileId: number) {
  return {
    id: fileId,
    projectId,
    fileName: `Addon${projectId}.zip`,
    gameVersionTypeIds: [88568],
    gameVersions: ["1.60.1"],
    releaseType: 1,
  };
}
function cfDependencies(
  dependencies: {
    id: number;
    type: "RequiredDependency" | "OptionalDependency" | "EmbeddedLibrary";
  }[] = [],
) {
  return {
    data: dependencies.map((dependency) => ({
      ...dependency,
      name: `Mod ${dependency.id}`,
      slug: `mod-${dependency.id}`,
    })),
    pagination: { index: 0, pageSize: 50, totalCount: dependencies.length },
  };
}
async function dependencyRoutes() {
  const parent = await zip({ "Parent/Parent.toc": "## Interface: 16001" });
  const dependency = await zip({ "Core/Core.toc": "## Interface: 16001" });
  return routeFetch({
    "https://api.cfwidget.com/wow/addons/1000": { id: 1000, title: "Parent" },
    "https://api.cfwidget.com/wow/addons/2000": { id: 2000, title: "Core" },
    [cfFilesUrl(1000)]: {
      data: [cfFile(1000, 1)],
      pagination: { totalCount: 1 },
    },
    [cfDependenciesUrl(1000, 1)]: cfDependencies([
      { id: 2000, type: "RequiredDependency" },
      { id: 3000, type: "OptionalDependency" },
    ]),
    [cfFilesUrl(2000)]: {
      data: [cfFile(2000, 2)],
      pagination: { totalCount: 1 },
    },
    [cfDependenciesUrl(2000, 2)]: cfDependencies([{ id: 2000, type: "RequiredDependency" }]),
    [cfDownloadUrl(1000, 1)]: new Response(parent),
    [cfDownloadUrl(2000, 2)]: new Response(dependency),
  });
}
test("add installs a required CurseForge dependency and ignores optional ones", async () => {
  const routes = await dependencyRoutes();
  setFetch(routes.fetch);
  const row = await addAddon(fixture.ctx, "cf:1000", { install: true });
  expect(row.status).toBe("current");
  expect(row.dependencies?.map((dependency) => dependency.entry.id)).toEqual(["cf:2000"]);
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe(
    "cf 1000  # Parent\ncf 2000  # Core\n",
  );
  const state = await readState(fixture.ctx);
  expect(Object.keys(state.addons).sort()).toEqual(["cf:1000", "cf:2000"]);
  expect(state.addons["cf:2000"].folders).toEqual(["Core"]);
  expect(routes.calls.some((url) => url.includes("/mods/3000/"))).toBe(false);
  expect(routes.calls.filter((url) => url === cfDownloadUrl(2000, 2))).toHaveLength(1);
});
test("an already tracked dependency is not resolved or added again", async () => {
  await writeFile(manifestPath(fixture.ctx), "cf 2000\n");
  const routes = await dependencyRoutes();
  setFetch(routes.fetch);
  const row = await addAddon(fixture.ctx, "cf:1000", { install: true });
  expect(row.status).toBe("current");
  expect(row.dependencies).toBeUndefined();
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("cf 2000\ncf 1000  # Parent\n");
  expect(routes.calls.some((url) => url.includes("/mods/2000/"))).toBe(false);
});
test("a dependency whose folders another tracked addon installed is left out", async () => {
  await writeFile(manifestPath(fixture.ctx), "gh a/b\n");
  const state = await readState(fixture.ctx);
  state.addons["gh:a/b"] = {
    version: "v1",
    versionKey: "1",
    folders: ["Core"],
    installedAt: "now",
  };
  await writeState(fixture.ctx, state);
  setFetch((await dependencyRoutes()).fetch);
  const row = await addAddon(fixture.ctx, "cf:1000", { install: true });
  expect(row.status).toBe("current");
  expect(row.dependencies).toBeUndefined();
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("gh a/b\ncf 1000  # Parent\n");
  expect((await readState(fixture.ctx)).addons["cf:2000"]).toBeUndefined();
});
test("sync installs a required dependency of a tracked CurseForge addon", async () => {
  await writeFile(manifestPath(fixture.ctx), "cf 1000\n");
  const routes = await dependencyRoutes();
  setFetch(routes.fetch);
  const { rows } = await syncAddons(fixture.ctx, {});
  expect(rows[0].status).toBe("current");
  expect(rows[0].dependencies?.map((dependency) => dependency.entry.id)).toEqual(["cf:2000"]);
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("cf 1000\ncf 2000  # Core\n");
  expect(Object.keys((await readState(fixture.ctx)).addons).sort()).toEqual(["cf:1000", "cf:2000"]);
});
test("sync --dry-run reports the dependency and writes nothing", async () => {
  await writeFile(manifestPath(fixture.ctx), "cf 1000\n");
  setFetch((await dependencyRoutes()).fetch);
  const { rows } = await syncAddons(fixture.ctx, { dryRun: true });
  expect(rows[0].dependencies?.map((dependency) => dependency.entry.id)).toEqual(["cf:2000"]);
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("cf 1000\n");
  expect(await readState(fixture.ctx)).toMatchObject({ addons: {} });
  expect(await readdir(fixture.ctx.addonsDir)).toEqual([]);
});
test("a dependency cycle terminates after installing each addon once", async () => {
  const routes = await dependencyRoutes();
  setFetch(routes.fetch);
  const row = await addAddon(fixture.ctx, "cf:1000", { install: true });
  expect(row.status).toBe("current");
  expect(row.dependencies?.map((dependency) => dependency.entry.id)).toEqual(["cf:2000"]);
  expect(routes.calls.filter((url) => url === cfDownloadUrl(1000, 1))).toHaveLength(1);
  expect(routes.calls.filter((url) => url === cfDownloadUrl(2000, 2))).toHaveLength(1);
  expect(Object.keys((await readState(fixture.ctx)).addons).sort()).toEqual(["cf:1000", "cf:2000"]);
});
test("add --dry-run reports dependencies and writes nothing", async () => {
  setFetch((await dependencyRoutes()).fetch);
  const row = await addAddon(fixture.ctx, "cf:1000", { install: true, dryRun: true });
  expect(row.dependencies?.map((dependency) => dependency.entry.id)).toEqual(["cf:2000"]);
  await expect(readFile(manifestPath(fixture.ctx), "utf8")).rejects.toThrow();
  expect(await readState(fixture.ctx)).toMatchObject({ addons: {} });
  expect(await readdir(fixture.ctx.addonsDir)).toEqual([]);
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
});
test("check reports a required dependency neither tracked nor installed", async () => {
  await writeFile(manifestPath(fixture.ctx), "cf 1000\n");
  const routes = await dependencyRoutes();
  setFetch(routes.fetch);
  expect((await listRows(fixture.ctx, { refresh: true }))[0].missingDependencies).toEqual([
    "cf:2000",
  ]);
  // Tracked: no longer missing.
  await writeFile(manifestPath(fixture.ctx), "cf 1000\ncf 2000\n");
  expect((await listRows(fixture.ctx, { refresh: true }))[0].missingDependencies).toBeUndefined();
  // Installed under its own id but not tracked: still not reported.
  await writeFile(manifestPath(fixture.ctx), "cf 1000\n");
  const state = await readState(fixture.ctx);
  state.addons["cf:2000"] = {
    version: "v1",
    versionKey: "2",
    folders: ["Core"],
    installedAt: "now",
  };
  await writeState(fixture.ctx, state);
  expect((await listRows(fixture.ctx, { refresh: true }))[0].missingDependencies).toBeUndefined();
});
