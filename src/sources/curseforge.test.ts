import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setFetch } from "../http";
import widget from "../testing/fixtures/cfwidget-auctionator.json";
import forever from "../testing/fixtures/curseforge-forever.json";
import { json, offline, routeFetch, tempContext } from "../testing/helpers";
import {
  type CfFile,
  cachedCfId,
  cfMatches,
  downloadCurseforge,
  resolveCfProject,
  resolveCurseforge,
} from "./curseforge";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  offline();
  fixture = await tempContext();
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});
const filesUrl = (id = "1708506", page = 0) =>
  `https://www.curseforge.com/api/v1/mods/${id}/files?pageIndex=${page}&pageSize=50&sort=dateCreated&sortDescending=true`;
const file = (overrides: Partial<CfFile> = {}): CfFile => ({ ...forever.data[0], ...overrides });
const page = (data: CfFile[], totalCount = data.length) => ({ data, pagination: { totalCount } });
test("recorded keyless Forever file has the verified ID/type", async () => {
  setFetch(routeFetch({ [filesUrl()]: forever }).fetch);
  expect(await resolveCurseforge(fixture.ctx, "1708506")).toMatchObject({
    versionKey: "8970646",
    version: "v0.4.1-forever",
    url: "https://www.curseforge.com/api/v1/mods/1708506/files/8970646/download",
  });
});
test("explicit foreign IDs exclude even a matching version string", () => {
  expect(
    cfMatches(file({ gameVersionTypeIds: [67408], gameVersions: ["1.60.1"] }), "forever"),
  ).toBe(false);
  expect(cfMatches(file({ gameVersionTypeIds: [88568, 67408] }), "forever")).toBe(true);
  expect(
    cfMatches(
      file({ gameVersionTypeIds: undefined, sortableGameVersions: [{ gameVersionTypeId: 67408 }] }),
      "forever",
    ),
  ).toBe(false);
  expect(cfMatches(file({ gameVersionTypeIds: undefined }), "forever")).toBe(true);
  expect(
    cfMatches(
      file({ gameVersionTypeIds: undefined, gameVersions: ["1.600.1", "11.60.1"] }),
      "forever",
    ),
  ).toBe(false);
  expect(cfMatches(file({ gameVersionTypeIds: undefined, gameVersions: ["1.15.8"] }), "era")).toBe(
    true,
  );
});
test("pagination dedupes, excludes foreign project IDs, and prefers releases over newer beta", async () => {
  const first = Array.from({ length: 50 }, (_, i) =>
    file({ id: i + 1, gameVersionTypeIds: [67408] }),
  );
  const stable = file({ id: 777, dateCreated: "2026-01-01" });
  const routes = routeFetch({
    [filesUrl()]: page(first, 54),
    [filesUrl("1708506", 1)]: page(
      [first[0], stable, file({ id: 888, releaseType: 2 }), file({ id: 999, projectId: 1 })],
      54,
    ),
  });
  setFetch(routes.fetch);
  expect((await resolveCurseforge(fixture.ctx, "1708506")).versionKey).toBe("777");
  expect(routes.calls).toHaveLength(2);
});
test("beta fallback is explicit in release note", async () => {
  setFetch(routeFetch({ [filesUrl()]: page([file({ releaseType: 2 })]) }).fetch);
  expect((await resolveCurseforge(fixture.ctx, "1708506")).note).toBe("beta");
});
test("partial listing failure is unreachable, never no-build", async () => {
  setFetch(
    routeFetch({
      [filesUrl()]: page(
        Array.from({ length: 50 }, (_, i) => file({ id: i + 1, gameVersionTypeIds: [67408] })),
        100,
      ),
      [filesUrl("1708506", 1)]: new Response("bad gateway", { status: 502 }),
    }).fetch,
  );
  await expect(resolveCurseforge(fixture.ctx, "1708506")).rejects.toMatchObject({
    code: "CF_UNREACHABLE",
  });
});
test("challenge 403 is actionable and does not invoke official API without a key", async () => {
  const routes = routeFetch({ [filesUrl()]: new Response("challenge", { status: 403 }) });
  setFetch(routes.fetch);
  await expect(resolveCurseforge(fixture.ctx, "1708506")).rejects.toThrow(
    "CurseForge blocked the request (try again later)",
  );
  expect(routes.calls).toHaveLength(1);
});
test("no matching build names Classic Era", async () => {
  setFetch(
    routeFetch({
      [filesUrl()]: page([file({ gameVersionTypeIds: [67408], gameVersions: ["1.15.8"] })]),
    }).fetch,
  );
  await expect(resolveCurseforge(fixture.ctx, "1708506")).rejects.toThrow(
    "No Forever build on CurseForge (latest is Classic Era)",
  );
});
test("slug resolution records numeric cfwidget ID and hits cache thereafter", async () => {
  const routes = routeFetch({ "https://api.cfwidget.com/wow/addons/auctionator": widget });
  setFetch(routes.fetch);
  expect(await resolveCfProject(fixture.ctx, "auctionator")).toEqual({
    id: "6124",
    title: "Auctionator",
  });
  expect(await resolveCfProject(fixture.ctx, "auctionator")).toEqual({ id: "6124" });
  expect(routes.calls).toHaveLength(1);
  expect(await cachedCfId(fixture.ctx, "auctionator")).toBe("6124");
});
test("404 invalidates a slug cache and re-resolves once", async () => {
  await mkdir(join(fixture.ctx.configDir, "cache"));
  await writeFile(join(fixture.ctx.configDir, "cache/cf-slugs.json"), '{"tweaks-forever":"123"}');
  const routes = routeFetch({
    [filesUrl("123")]: new Response(null, { status: 404 }),
    "https://api.cfwidget.com/wow/addons/tweaks-forever": { id: 1708506 },
    [filesUrl()]: forever,
  });
  setFetch(routes.fetch);
  expect((await resolveCurseforge(fixture.ctx, "tweaks-forever")).versionKey).toBe("8970646");
  expect(routes.calls).toHaveLength(3);
  expect(
    JSON.parse(await readFile(join(fixture.ctx.configDir, "cache/cf-slugs.json"), "utf8")),
  ).toEqual({ "tweaks-forever": "1708506" });
});
test("invalid widget IDs are rejected", async () => {
  setFetch(async () => json({ id: "javascript:bad" }));
  await expect(resolveCfProject(fixture.ctx, "unknown")).rejects.toMatchObject({ code: "CF_NAME" });
});
test("official fallback only after keyless failure and with a key", async () => {
  await writeFile(join(fixture.ctx.configDir, "cf_token"), "cf-secret");
  const calls: string[] = [];
  setFetch(async (url, init) => {
    calls.push(url);
    if (url.startsWith("https://www.curseforge.com/")) {
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
      return new Response(null, { status: 403 });
    }
    expect(url).toBe("https://api.curseforge.com/v1/mods/1708506/files?index=0&pageSize=50");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("cf-secret");
    return json(forever);
  });
  expect((await resolveCurseforge(fixture.ctx, "1708506")).versionKey).toBe("8970646");
  expect(calls).toHaveLength(2);
});

test("prototype names are valid slugs, never inherited cache IDs", async () => {
  setFetch(routeFetch({ "https://api.cfwidget.com/wow/addons/constructor": { id: 6124 } }).fetch);
  expect(await resolveCfProject(fixture.ctx, "constructor")).toMatchObject({ id: "6124" });
});
test("pagination stops at ten pages", async () => {
  let calls = 0;
  setFetch(async (url) => {
    expect(url).toBe(filesUrl("1708506", calls));
    calls++;
    return json(
      page(
        Array.from({ length: 50 }, (_, i) => file({ id: calls * 50 + i })),
        1000,
      ),
    );
  });
  expect((await resolveCurseforge(fixture.ctx, "1708506")).versionKey).toBe("549");
  expect(calls).toBe(10);
});

test("keyless download follows only forgecdn redirects without secrets", async () => {
  const endpoint = "https://www.curseforge.com/api/v1/mods/1708506/files/8970646/download";
  const calls: string[] = [];
  setFetch(async (url, init) => {
    calls.push(url);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
    if (url === endpoint)
      return new Response(null, {
        status: 302,
        headers: { location: "https://edge.forgecdn.net/files/8970/646/file.zip" },
      });
    expect(url).toBe("https://edge.forgecdn.net/files/8970/646/file.zip");
    return new Response("zip bytes");
  });
  expect(
    new TextDecoder().decode(
      await downloadCurseforge(fixture.ctx, {
        version: "v1",
        versionKey: "8970646",
        archive: "package",
        url: endpoint,
      }),
    ),
  ).toBe("zip bytes");
  expect(calls).toHaveLength(2);
});
test("blocked keyless download uses keyed official URL fallback", async () => {
  await writeFile(join(fixture.ctx.configDir, "cf_token"), "cf-secret");
  const endpoint = "https://www.curseforge.com/api/v1/mods/1708506/files/8970646/download";
  setFetch(async (url, init) => {
    if (url === endpoint) return new Response(null, { status: 403 });
    if (url === "https://api.curseforge.com/v1/mods/1708506/files/8970646/download-url") {
      expect(new Headers(init?.headers).get("x-api-key")).toBe("cf-secret");
      return json({ data: "https://edge.forgecdn.net/file.zip" });
    }
    expect(url).toBe("https://edge.forgecdn.net/file.zip");
    expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
    return new Response("zip");
  });
  expect(
    new TextDecoder().decode(
      await downloadCurseforge(fixture.ctx, {
        version: "v1",
        versionKey: "8970646",
        archive: "package",
        url: endpoint,
      }),
    ),
  ).toBe("zip");
});
test("hostile CF download redirects never trigger a request to the target", async () => {
  let calls = 0;
  setFetch(async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://evil.test/file.zip" } });
  });
  await expect(
    downloadCurseforge(fixture.ctx, {
      version: "v1",
      versionKey: "8970646",
      archive: "package",
      url: "https://www.curseforge.com/api/v1/mods/1708506/files/8970646/download",
    }),
  ).rejects.toMatchObject({ code: "HTTP_REDIRECT" });
  expect(calls).toBe(1);
});
