import { afterEach, beforeEach, expect, test } from "bun:test";
import { setFetch } from "../http";
import { offline, routeFetch, tempContext } from "../testing/helpers";
import { assetScore, resolveGithub } from "./github";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  offline();
  fixture = await tempContext();
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});
const api = "https://api.github.com/repos/owner/repo";
const asset = (name: string, id = 1) => ({
  id,
  name,
  updated_at: "today",
  browser_download_url: `https://github.com/owner/repo/releases/download/v1/${name}`,
});
const release = (assets: ReturnType<typeof asset>[], tag_name = "v1") => ({
  tag_name,
  draft: false,
  prerelease: false,
  assets,
});
test("flavor tokens are delimiter-bounded and nolib loses", () => {
  expect(assetScore("Foo-forever.zip", "forever")).toBeGreaterThan(
    assetScore("Foo.zip", "forever") ?? 0,
  );
  expect(assetScore("Foo-forever-nolib.zip", "forever")).toBeLessThan(
    assetScore("Foo-forever.zip", "forever") ?? 0,
  );
  for (const foreign of ["classic", "vanilla", "bcc", "wrath", "cata", "mists", "mainline"])
    expect(assetScore(`Foo-${foreign}.zip`, "forever")).toBeUndefined();
  expect(assetScore("ClassicCastbars.zip", "forever")).toBe(0);
  expect(assetScore("Foo-classic.zip", "era")).toBe(10);
  expect(assetScore("Foo-forever.zip", "era")).toBeUndefined();
});
test("chooses own flavor over generic and nolib", async () => {
  const routes = routeFetch({
    [`${api}/releases?per_page=100&page=1`]: [
      release([
        asset("Foo-classic.zip"),
        asset("Foo-forever.zip", 2),
        asset("Foo-forever-nolib.zip", 3),
      ]),
    ],
  });
  setFetch(routes.fetch);
  expect(await resolveGithub(fixture.ctx, "owner/repo")).toMatchObject({
    version: "v1",
    versionKey: "2:today",
    archive: "package",
  });
});
test("ambiguous assets fail", async () => {
  setFetch(
    routeFetch({
      [`${api}/releases?per_page=100&page=1`]: [
        release([asset("Foo-forever.zip"), asset("Bar-forever.zip", 2)]),
      ],
    }).fetch,
  );
  await expect(resolveGithub(fixture.ctx, "owner/repo")).rejects.toMatchObject({
    code: "ASSET_AMBIGUOUS",
  });
});
test("walks older releases, ignoring drafts and prereleases", async () => {
  setFetch(
    routeFetch({
      [`${api}/releases?per_page=100&page=1`]: [
        { ...release([asset("Foo-forever.zip")], "draft"), draft: true },
        { ...release([asset("Foo-forever.zip")], "pre"), prerelease: true },
        release([asset("Foo-classic.zip")], "newest"),
        release([asset("Foo-forever.zip")], "older"),
      ],
    }).fetch,
  );
  expect((await resolveGithub(fixture.ctx, "owner/repo")).version).toBe("older");
});
test("incompatible ZIPs do not silently fall back to source", async () => {
  setFetch(
    routeFetch({ [`${api}/releases?per_page=100&page=1`]: [release([asset("Foo-mainline.zip")])] })
      .fetch,
  );
  await expect(resolveGithub(fixture.ctx, "owner/repo")).rejects.toMatchObject({
    code: "NO_BUILD",
  });
});
test("no ZIP uses default branch resolved SHA", async () => {
  const sha = "a".repeat(40);
  setFetch(
    routeFetch({
      [`${api}/releases?per_page=100&page=1`]: [],
      [api]: { default_branch: "stable/forever" },
      [`${api}/commits/stable%2Fforever`]: { sha },
    }).fetch,
  );
  expect(await resolveGithub(fixture.ctx, "owner/repo")).toEqual({
    archive: "source",
    url: `${api}/zipball/${sha}`,
    version: sha.slice(0, 12),
    versionKey: sha,
  });
});

test("multi-flavor assets retain their own flavor score", () => {
  for (const flavor of ["era", "forever"] as const) {
    expect(assetScore("Foo-classic-forever-mainline.zip", flavor)).toBe(10);
    expect(assetScore("Foo-classic-forever-nolib.zip", flavor)).toBe(5);
    expect(assetScore("Foo-mainline-wrath.zip", flavor)).toBeUndefined();
  }
});
