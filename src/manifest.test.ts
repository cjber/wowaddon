import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { manifestPath, readManifest, writeManifest } from "./manifest";
import { tempContext } from "./testing/helpers";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  fixture = await tempContext();
});
afterEach(async () => {
  await fixture.cleanup();
});
test("text manifests preserve notes and canonicalize legacy references", async () => {
  await writeFile(
    manifestPath(fixture.ctx),
    "# comment\ngh Owner/Repo  # useful # note\ncf auctionator  # Auctionator\nwowi 123\n",
  );
  const entries = await readManifest(fixture.ctx, async (slug) => {
    expect(slug).toBe("auctionator");
    return "6124";
  });
  expect(entries).toEqual([
    { id: "gh:owner/repo", kind: "gh", ref: "owner/repo", note: "useful # note" },
    { id: "cf:6124", kind: "cf", ref: "6124", note: "Auctionator" },
    { id: "wowi:123", kind: "wowi", ref: "123" },
  ]);
  await writeManifest(fixture.ctx, entries);
  expect(await readFile(manifestPath(fixture.ctx), "utf8")).toContain("cf 6124  # Auctionator");
});
test("canonical duplicate identities are rejected", async () => {
  await writeFile(manifestPath(fixture.ctx), "gh A/B\ngh a/b\n");
  await expect(readManifest(fixture.ctx)).rejects.toMatchObject({ code: "DUPLICATE" });
});
test("notes cannot inject manifest rows", async () => {
  await writeManifest(fixture.ctx, [
    { id: "cf:6124", kind: "cf", ref: "6124", note: "A\ngh evil/repo" },
  ]);
  expect(await readManifest(fixture.ctx)).toHaveLength(1);
});
