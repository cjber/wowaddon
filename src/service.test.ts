import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { setFetch } from "./http";
import { manifestPath } from "./manifest";
import { addAddon, listRows, removeAddon, syncAddons } from "./service";
import { readState, writeState } from "./state";
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
test("add, local list, unchanged sync, and remove use the service contract", async () => {
  const calls = await installRoutes();
  const progress: Progress[] = [];
  const row = await addAddon(fixture.ctx, "a/b", {
    install: true,
    onProgress: (p) => progress.push(p),
  });
  expect(row.status).toBe("current");
  expect(progress.map((p) => p.phase)).toEqual(["resolving", "downloading", "installing", "done"]);
  expect((await listRows(fixture.ctx, { refresh: false }))[0].status).toBe("unknown");
  expect(calls).toHaveLength(2);
  expect((await syncAddons(fixture.ctx, { ids: ["https://github.com/A/B"] })).rows[0].message).toBe(
    "up to date",
  );
  expect(calls).toHaveLength(3);
  await removeAddon(fixture.ctx, "gh:A/B");
  expect((await readState(fixture.ctx)).addons).toEqual({});
  expect(await listRows(fixture.ctx, { refresh: false })).toEqual([]);
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

test("CF install writes the resolved title and reports a missing build without losing the entry", async () => {
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
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toBe("cf 6124  # Auctionator\n");
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
