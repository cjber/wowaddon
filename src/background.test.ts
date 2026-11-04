import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cachedReleases,
  isNewer,
  nextSchedule,
  recordReleases,
  runBackground,
  selfCommand,
  setLaunch,
  startBackgroundChecks,
  updateNotice,
} from "./background";
import { setFetch } from "./http";
import { json, offline, routeFetch, tempContext } from "./testing/helpers";
import type { Entry, Row } from "./types";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const LATEST = "https://api.github.com/repos/cjber/wowaddon/releases/latest";
const entry: Entry = { id: "gh:a/b", kind: "gh", ref: "a/b" };
const release = { version: "v2", versionKey: "2", url: "https://x", archive: "package" as const };
const row: Row = { entry, latest: release, status: "update" };

let fixture: Awaited<ReturnType<typeof tempContext>>;
let launched: string[][];
beforeEach(async () => {
  offline();
  fixture = await tempContext();
  launched = [];
  setLaunch((argv) => launched.push(argv));
});
afterEach(async () => {
  setLaunch(() => {});
  offline();
  await fixture.cleanup();
});
const check = async (name: string) =>
  JSON.parse(
    await readFile(join(fixture.ctx.configDir, "cache", "checks", `${name}.json`), "utf8"),
  );

test("a failure backs off from 15 minutes, doubling to a day; a success waits the interval", () => {
  let schedule = nextSchedule(undefined, false, HOUR, 0);
  const waits = [schedule.nextAt];
  for (let i = 0; i < 8; i++) {
    schedule = nextSchedule(schedule, false, HOUR, 0);
    waits.push(schedule.nextAt);
  }
  expect(waits.map((ms) => ms / 60_000)).toEqual([15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
  expect(nextSchedule(schedule, true, HOUR, 0)).toEqual({ nextAt: HOUR, failures: 0 });
});

test("versions compare numerically and ignore anything that is not x.y.z", () => {
  expect(isNewer("v2.10.0", "2.9.9")).toBe(true);
  expect(isNewer("2.1.3", "2.1.3")).toBe(false);
  expect(isNewer("2.1.2", "2.1.3")).toBe(false);
  expect(isNewer("v3.0.0-beta", "2.1.3")).toBe(false);
});

test("a compiled binary reruns itself; a source run passes its script to bun", () => {
  expect(selfCommand("/$bunfs/root/wowaddon", "/home/u/wowaddon")).toEqual(["/home/u/wowaddon"]);
  expect(selfCommand("/repo/src/index.tsx", "/usr/bin/bun")).toEqual([
    "/usr/bin/bun",
    "/repo/src/index.tsx",
  ]);
});

test("an interactive run starts one worker for the due checks and never waits on it", async () => {
  await startBackgroundChecks(fixture.ctx, { addons: false, interactive: true, now: NOW });
  expect(launched).toHaveLength(1);
  expect(launched[0].slice(-6)).toEqual([
    "__background",
    "--flavor",
    "forever",
    "--addons-dir",
    fixture.ctx.addonsDir,
    "self",
  ]);
  // The CLI also asks for this flavor's addon refresh, due on a first run.
  launched = [];
  await startBackgroundChecks(fixture.ctx, { addons: true, interactive: true, now: NOW });
  expect(launched[0]).toContain("addons:forever");
});

test("no worker for a non-interactive run, an opt-out or a check that is not due", async () => {
  await startBackgroundChecks(fixture.ctx, { addons: true, interactive: false, now: NOW });
  const optedOut = await tempContext("forever", { WOWADDON_NO_UPDATE_CHECK: "1" });
  await startBackgroundChecks(optedOut.ctx, { addons: true, interactive: true, now: NOW });
  await optedOut.cleanup();
  expect(launched).toEqual([]);

  await recordReleases(fixture.ctx, [row], { complete: true }, NOW);
  setFetch(routeFetch({ [LATEST]: { tag_name: "v2.1.3" } }).fetch);
  await runBackground(fixture.ctx, ["self"], async () => {}, NOW);
  await startBackgroundChecks(fixture.ctx, { addons: true, interactive: true, now: NOW + 1 });
  expect(launched).toEqual([]);
});

test("a cached release is used only when fetched after the install and within a week", async () => {
  await recordReleases(fixture.ctx, [row], { complete: true }, NOW);
  const installed = (at: number) => ({
    version: "v1",
    versionKey: "1",
    folders: ["B"],
    installedAt: new Date(at).toISOString(),
  });
  expect((await cachedReleases(fixture.ctx, NOW))(entry, installed(NOW - HOUR))).toEqual(release);
  expect((await cachedReleases(fixture.ctx, NOW))(entry, installed(NOW + HOUR))).toBeUndefined();
  expect((await cachedReleases(fixture.ctx, NOW + 8 * 24 * HOUR))(entry)).toBeUndefined();
  expect((await cachedReleases(fixture.ctx, NOW))({ ...entry, id: "gh:c/d" })).toBeUndefined();
});

test("a complete refresh replaces the cache and settles the addon check; all-failed backs off", async () => {
  await recordReleases(fixture.ctx, [row], { complete: true }, NOW);
  expect(await check("addons-forever")).toEqual({ nextAt: NOW + HOUR, failures: 0 });
  const failed: Row = { entry, status: "error", message: "offline" };
  await recordReleases(fixture.ctx, [failed], { complete: true }, NOW + HOUR);
  expect((await check("addons-forever")).failures).toBe(1);
  // The failed row keeps its last release; an addon gone from the manifest is dropped.
  expect((await cachedReleases(fixture.ctx, NOW))(entry)).toEqual(release);
  await recordReleases(fixture.ctx, [], { complete: true }, NOW);
  expect((await cachedReleases(fixture.ctx, NOW))(entry)).toBeUndefined();
});

test("the worker records a newer release, and the notice reads it from the cache", async () => {
  setFetch(routeFetch({ [LATEST]: { tag_name: "v9.0.0" } }).fetch);
  await runBackground(fixture.ctx, ["self"], async () => {}, NOW);
  expect(await check("self")).toMatchObject({ latestVersion: "v9.0.0", failures: 0 });
  expect(await updateNotice(fixture.ctx, "2.1.3")).toBe(
    "wowaddon 9.0.0 is available (you have 2.1.3): https://github.com/cjber/wowaddon/releases",
  );
  expect(await updateNotice(fixture.ctx, "9.0.0")).toBeUndefined();
  const optedOut = await tempContext("forever", {
    XDG_CONFIG_HOME: join(fixture.root, "config"),
    WOWADDON_NO_UPDATE_CHECK: "1",
  });
  expect(await updateNotice(optedOut.ctx, "2.1.3")).toBeUndefined();
  await optedOut.cleanup();
});

test("a failed self check backs off; a failed addon refresh does too", async () => {
  setFetch(async () => json({}, 500));
  await runBackground(
    fixture.ctx,
    ["self", "addons:forever"],
    async () => {
      throw new Error("offline");
    },
    NOW,
  );
  expect((await check("self")).failures).toBe(1);
  expect((await check("addons-forever")).failures).toBe(1);
});

test("a live lease keeps a second worker out; an expired one is taken over", async () => {
  const lease = join(fixture.ctx.configDir, "cache", "background.lease");
  await recordReleases(fixture.ctx, [], { complete: false }, NOW);
  await writeFile(lease, JSON.stringify({ pid: 1, until: NOW + HOUR }));
  let refreshed = 0;
  const refresh = async () => {
    refreshed++;
  };
  await runBackground(fixture.ctx, ["addons:forever"], refresh, NOW);
  expect(refreshed).toBe(0);
  await runBackground(fixture.ctx, ["addons:forever"], refresh, NOW + 2 * HOUR);
  expect(refreshed).toBe(1);
  await expect(readFile(lease)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a worker that outlived its lease leaves the newer worker's lease in place", async () => {
  const lease = join(fixture.ctx.configDir, "cache", "background.lease");
  const newer = JSON.stringify({ token: "newer", until: NOW + 2 * HOUR });
  await runBackground(
    fixture.ctx,
    ["addons:forever"],
    async () => {
      // Another worker took over this lease after it expired.
      await writeFile(lease, newer);
    },
    NOW,
  );
  expect(await readFile(lease, "utf8")).toBe(newer);
});
