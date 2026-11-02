import { afterEach, beforeEach, expect, test } from "bun:test";
import { setFetch } from "../http";
import elvui from "../testing/fixtures/tukui-elvui.json";
import { json, offline, routeFetch, tempContext } from "../testing/helpers";
import { resolveTukui } from "./tukui";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  offline();
  fixture = await tempContext();
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});
test("Tukui keys a release by its date and version, not its per-request download URL", async () => {
  const route = routeFetch({ "https://api.tukui.org/v1/addon/elvui": elvui });
  setFetch(route.fetch);
  expect(await resolveTukui(fixture.ctx, "elvui")).toEqual({
    version: "16.00",
    versionKey: "2026-10-13:16.00",
    url: "https://api.tukui.org/v1/download/elvui/TOKEN",
    archive: "package",
  });
  expect(route.calls).toEqual(["https://api.tukui.org/v1/addon/elvui"]);
});
test("Tukui rejects a mismatched slug and an insecure download", async () => {
  setFetch(async () => json({ ...elvui, slug: "tukui" }));
  await expect(resolveTukui(fixture.ctx, "elvui")).rejects.toMatchObject({
    code: "SOURCE_RESPONSE",
  });
  setFetch(async () => json({ ...elvui, url: "http://api.tukui.org/x.zip" }));
  await expect(resolveTukui(fixture.ctx, "elvui")).rejects.toMatchObject({ code: "HTTP_URL" });
});
