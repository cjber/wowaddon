import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setFetch } from "../http";
import { installAddon } from "../install";
import { readState } from "../state";
import { json, offline, tempContext, zip } from "../testing/helpers";
import { resolveWago } from "./wago";

const API = "https://addons.wago.io/api/external/addons/details?game_version=forever";
// Response fields as CurseBreaker reads them; no key was available to record a live fixture.
const project = (recent: Record<string, unknown>) => ({ slug: "details", recent_release: recent });
const stable = {
  label: "v2",
  created_at: "2026-10-01T00:00:00Z",
  download_link: "https://addons-files.wago.io/details-v2.zip",
};

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  offline();
  fixture = await tempContext();
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});
test("Wago without a key fails with a typed error and makes no request", async () => {
  await expect(resolveWago(fixture.ctx, "details")).rejects.toMatchObject({
    code: "WAGO_KEY_MISSING",
    message: expect.stringContaining("WAGO_ADDONS_API_KEY"),
  });
});
test("Wago sends the token file's key only to the API host", async () => {
  await writeFile(join(fixture.ctx.configDir, "wago_token"), "wago-secret\n");
  const seen: Record<string, string | null> = {};
  const bytes = await zip({ "Details/Details.toc": "## Interface: 16001" });
  setFetch(async (url, init) => {
    seen[url] = new Headers(init?.headers).get("authorization");
    if (url === API) return json(project({ stable, beta: { ...stable, label: "v3-beta" } }));
    if (url === stable.download_link) return new Response(bytes);
    throw new Error(`Unexpected network request: ${url}`);
  });
  const release = await resolveWago(fixture.ctx, "details");
  expect(release).toEqual({
    version: "v2",
    versionKey: "2026-10-01T00:00:00Z:v2",
    url: stable.download_link,
    archive: "package",
  });
  const entry = { id: "wago:details", kind: "wago" as const, ref: "details" };
  const state = await readState(fixture.ctx);
  expect((await installAddon(fixture.ctx, state, entry, release)).status).toBe("current");
  expect(seen).toEqual({ [API]: "Bearer wago-secret", [stable.download_link]: null });
});
test("Wago picks the newest prerelease without a stable one and maps key rejections", async () => {
  await writeFile(join(fixture.ctx.configDir, "wago_token"), "k");
  setFetch(async () =>
    json(
      project({
        alpha: { ...stable, label: "a", created_at: "2026-10-03T00:00:00Z" },
        beta: { ...stable, label: "b", created_at: "2026-10-02T00:00:00Z" },
      }),
    ),
  );
  expect(await resolveWago(fixture.ctx, "details")).toMatchObject({ version: "a", note: "alpha" });
  setFetch(async () => json(project({})));
  await expect(resolveWago(fixture.ctx, "details")).rejects.toMatchObject({ code: "NO_BUILD" });
  setFetch(async () => json({}, 403));
  await expect(resolveWago(fixture.ctx, "details")).rejects.toMatchObject({
    code: "WAGO_KEY_INVALID",
  });
});
