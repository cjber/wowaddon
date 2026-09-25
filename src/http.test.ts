import { afterEach, expect, test } from "bun:test";
import { forgeRedirect, requestBytes, requestJson, setFetch } from "./http";
import { offline } from "./testing/helpers";

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
