import { afterEach, beforeEach, expect, test } from "bun:test";
import { setFetch } from "../http";
import { json, offline, tempContext } from "../testing/helpers";
import { resolveWowinterface } from "./wowinterface";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  offline();
  fixture = await tempContext();
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});
test("WoWI builds a date/version key and validates file ID", async () => {
  setFetch(async (url) => {
    expect(url).toBe("https://api.mmoui.com/v3/game/WOW/filedetails/123.json");
    return json([
      {
        UID: "123",
        UIDownload: "https://cdn.wowinterface.com/file.zip",
        UIDate: 1234,
        UIVersion: "v2",
      },
    ]);
  });
  expect(await resolveWowinterface(fixture.ctx, "123")).toEqual({
    version: "v2",
    versionKey: "1234:v2",
    url: "https://cdn.wowinterface.com/file.zip",
    archive: "package",
  });
});
test("WoWI rejects absent details and insecure download URLs", async () => {
  setFetch(async () => json([]));
  await expect(resolveWowinterface(fixture.ctx, "123")).rejects.toMatchObject({
    code: "SOURCE_RESPONSE",
  });
  setFetch(async () =>
    json([{ UIDownload: "http://cdn.wowinterface.com/file.zip", UIDate: 1, UIVersion: "v2" }]),
  );
  await expect(resolveWowinterface(fixture.ctx, "123")).rejects.toMatchObject({ code: "HTTP_URL" });
});
