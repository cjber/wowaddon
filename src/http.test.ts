import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  forgeRedirect,
  getCredentials,
  keyProblems,
  requestBytes,
  requestJson,
  setFetch,
} from "./http";
import { offline, tempContext } from "./testing/helpers";

afterEach(offline);
test("credentials recomputed per manual redirect, exact origins only", async () => {
  const urls = [
    "https://api.github.com/start",
    "https://api.github.com.evil.test/path",
    "https://api.github.com:8443/path",
    "https://cdn.example.com/file",
    "https://api.curseforge.com/v1/file",
    "https://api.github.com/final",
  ];
  const seen: { auth: string | null; key: string | null }[] = [];
  setFetch(async (url, init) => {
    expect(url).toBe(urls[seen.length]);
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    seen.push({ auth: headers.get("authorization"), key: headers.get("x-api-key") });
    return seen.length < urls.length
      ? new Response(null, { status: 302, headers: { location: urls[seen.length] } })
      : new Response("done");
  });
  expect(
    new TextDecoder().decode(
      await requestBytes(urls[0], {
        credentials: { github: "gh-secret", curseforge: "cf-secret" },
      }),
    ),
  ).toBe("done");
  expect(seen).toEqual([
    { auth: "Bearer gh-secret", key: null },
    { auth: null, key: null },
    { auth: null, key: null },
    { auth: null, key: null },
    { auth: null, key: "cf-secret" },
    { auth: "Bearer gh-secret", key: null },
  ]);
});
test("rejects non-HTTPS, embedded credentials, downgrade, missing and excessive redirects", async () => {
  offline();
  for (const url of ["http://api.github.com/x", "https://secret@api.github.com/x"])
    await expect(requestBytes(url)).rejects.toMatchObject({ code: "HTTP_URL" });
  setFetch(
    async () => new Response(null, { status: 302, headers: { location: "http://example.com" } }),
  );
  await expect(requestBytes("https://example.com")).rejects.toMatchObject({ code: "HTTP_URL" });
  setFetch(async () => new Response(null, { status: 302 }));
  await expect(requestBytes("https://example.com")).rejects.toMatchObject({
    code: "HTTP_REDIRECT",
  });
  let count = 0;
  setFetch(async () => {
    count++;
    return new Response(null, { status: 302, headers: { location: "/next" } });
  });
  await expect(requestBytes("https://example.com")).rejects.toMatchObject({
    code: "HTTP_REDIRECT",
  });
  expect(count).toBe(6);
});
test("redacts credentials in fetch errors and secret URL queries", async () => {
  setFetch(async () => {
    throw new Error("oops gh-secret cf-secret https://example.com?token=other");
  });
  try {
    await requestBytes("https://api.github.com", {
      credentials: { github: "gh-secret", curseforge: "cf-secret" },
    });
    throw new Error("expected error");
  } catch (error) {
    const message = (error as Error).message;
    expect(message).not.toContain("gh-secret");
    expect(message).not.toContain("cf-secret");
    expect(message).not.toContain("token=other");
    expect(message).toContain("[redacted]");
  }
});
test("enforces declared and streaming caps and invalid JSON", async () => {
  setFetch(async () => new Response("ok", { headers: { "content-length": "999" } }));
  await expect(requestBytes("https://example.com", { maxBytes: 2 })).rejects.toMatchObject({
    code: "HTTP_SIZE",
  });
  setFetch(async () => new Response("toolong"));
  await expect(requestBytes("https://example.com", { maxBytes: 2 })).rejects.toMatchObject({
    code: "HTTP_SIZE",
  });
  await expect(requestJson("https://example.com")).rejects.toMatchObject({ code: "HTTP_JSON" });
});
test("honors cancellation and timeout", async () => {
  offline();
  const controller = new AbortController();
  controller.abort();
  await expect(
    requestBytes("https://example.com", { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "ABORTED" });
  setFetch(
    async (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
  );
  await expect(requestBytes("https://example.com", { timeoutMs: 5 })).rejects.toMatchObject({
    code: "HTTP_TIMEOUT",
  });
});
test("reports exactly a 401/403 the CurseForge API gave a configured key, once", async () => {
  const fixture = await tempContext("forever");
  try {
    await writeFile(join(fixture.ctx.configDir, "cf_token"), "cf-secret");
    const credentials = await getCredentials(fixture.ctx);
    expect(credentials.curseforge).toBe("cf-secret");
    // Neither the website's own 403 nor any other API status is the API rejecting the key.
    for (const [url, status] of [
      ["https://www.curseforge.com/api/v1/mods/1/files", 403],
      ["https://api.curseforge.com/v1/mods/1", 404],
      ["https://api.curseforge.com/v1/mods/1", 500],
    ] as const) {
      setFetch(async () => new Response(null, { status }));
      await expect(requestJson(url, { credentials })).rejects.toMatchObject({
        code: `HTTP_${status}`,
      });
      expect(await keyProblems(fixture.ctx)).toEqual([]);
    }
    setFetch(async () => new Response(null, { status: 403 }));
    await expect(
      requestJson("https://api.curseforge.com/v1/mods/1", { credentials }),
    ).rejects.toMatchObject({ code: "HTTP_403" });
    const [problem] = await keyProblems(fixture.ctx);
    expect(problem).toMatchObject({
      source: "curseforge",
      status: 403,
      file: join(fixture.ctx.configDir, "cf_token"),
    });
    expect(problem.message).toContain("HTTP 403");
    expect(problem.message).toContain("cf_token");
    // A later rejection in the same run does not duplicate or replace the first one.
    setFetch(async () => new Response(null, { status: 401 }));
    await expect(
      requestJson("https://api.curseforge.com/v1/mods/1", { credentials }),
    ).rejects.toMatchObject({ code: "HTTP_401" });
    expect(await keyProblems(fixture.ctx)).toHaveLength(1);
    expect((await keyProblems(fixture.ctx))[0].status).toBe(403);
  } finally {
    offline();
    await fixture.cleanup();
  }
});
test("a 401 from the CurseForge API is reported too", async () => {
  const fixture = await tempContext("forever", { CF_API_KEY: "cf-secret" });
  try {
    const credentials = await getCredentials(fixture.ctx);
    setFetch(async () => new Response(null, { status: 401 }));
    await expect(
      requestJson("https://api.curseforge.com/v1/mods/1", { credentials }),
    ).rejects.toMatchObject({ code: "HTTP_401" });
    expect((await keyProblems(fixture.ctx))[0]).toMatchObject({ status: 401 });
  } finally {
    offline();
    await fixture.cleanup();
  }
});
test("no key means no report, even when the API answers 403", async () => {
  const fixture = await tempContext("forever");
  try {
    setFetch(async () => new Response(null, { status: 403 }));
    await expect(requestJson("https://api.curseforge.com/v1/mods/1")).rejects.toMatchObject({
      code: "HTTP_403",
    });
    expect(await keyProblems(fixture.ctx)).toEqual([]);
  } finally {
    offline();
    await fixture.cleanup();
  }
});
test("CF download redirects must reach HTTPS forgecdn subdomains", () => {
  expect(() => forgeRedirect(new URL("https://edge.forgecdn.net/files/1.zip"))).not.toThrow();
  for (const url of [
    "https://forgecdn.net.evil.test/f",
    "https://evilforgecdn.net/f",
    "http://edge.forgecdn.net/f",
    "https://edge.forgecdn.net:444/f",
  ])
    expect(() => forgeRedirect(new URL(url))).toThrow();
});
