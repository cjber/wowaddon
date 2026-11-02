import { expect, test } from "bun:test";
import { readArchive } from "./archive";
import { zip } from "./testing/helpers";

const toc = "## Interface: 16001\n";
test("valid multi-folder package skips foreign-only folders", async () => {
  const archive = await readArchive(
    await zip({
      "Foo/Foo.toc": toc,
      "Foo/a.lua": "print(1)",
      "Foreign/Foreign.toc": "## Interface: 11508",
      "NoToc/a.lua": "x",
    }),
    { flavor: "forever" },
  );
  expect(archive.folders).toEqual(["Foo"]);
  expect([...archive.files.keys()]).toEqual(["Foo/Foo.toc", "Foo/a.lua"]);
});
test("zero compatible or mismatched TOC name fails", async () => {
  await expect(
    readArchive(await zip({ "Foo/Foo.toc": "## Interface: 11508" }), { flavor: "forever" }),
  ).rejects.toMatchObject({ code: "NO_BUILD" });
  await expect(
    readArchive(await zip({ "Foo/Bar.toc": toc }), { flavor: "forever" }),
  ).rejects.toMatchObject({ code: "NO_BUILD" });
});
test("GitHub source root folder uses TOC name with _Forever stripped", async () => {
  const archive = await readArchive(
    await zip({
      "owner-project-abc/Tweaks_Forever.toc": toc,
      "owner-project-abc/init.lua": "x",
      "owner-project-abc/README.md": "read",
    }),
    { flavor: "forever", source: true },
  );
  expect(archive.folders).toEqual(["Tweaks"]);
  expect(archive.files.has("Tweaks/init.lua")).toBe(true);
});
test("source multi-addon repository unwraps a single root", async () => {
  const archive = await readArchive(
    await zip({ "root/A/A.toc": toc, "root/B/B-Forever.toc": toc }),
    { flavor: "forever", source: true },
  );
  expect(archive.folders).toEqual(["A", "B"]);
});
for (const name of [
  "../bad.lua",
  "/absolute.lua",
  "C:/drive.lua",
  "//server/share.lua",
  "..\\bad.lua",
  "\\absolute.lua",
  "C:\\drive.lua",
  "Foo\\..\\bad.lua",
  "Foo/.git/config",
  "Foo/.GIT",
  "Foo/../bad.lua",
  "Foo/bad:stream",
  "Foo/a. ",
])
  test(`reject unsafe ZIP path ${name}`, async () => {
    await expect(
      readArchive(await zip({ "Foo/Foo.toc": toc, [name]: "bad" }), { flavor: "forever" }),
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
  });
test("backslash-separated paths read as folders", async () => {
  // Windows tools also write each folder as its own entry ending in a backslash.
  const archive = await readArchive(
    await zip(
      { "Foo\\": "", "Foo\\Libs\\": "", "Foo\\Foo.toc": toc, "Foo\\a.lua": "x" },
      // As AtlasLoot's package has them: no Unix mode bits.
      { "Foo\\": { msDosCompatible: true }, "Foo\\Libs\\": { msDosCompatible: true } },
    ),
    { flavor: "forever" },
  );
  expect(archive.folders).toEqual(["Foo"]);
  expect([...archive.files.keys()]).toEqual(["Foo/Foo.toc", "Foo/a.lua"]);
  await expect(
    readArchive(await zip({ "Foo/Foo.toc": toc, "Foo\\Foo.toc": toc }), { flavor: "forever" }),
  ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
});
for (const unixMode of [0o120777, 0o020600, 0o010600])
  test(`reject Unix special entry ${unixMode}`, async () => {
    await expect(
      readArchive(
        await zip({ "Foo/Foo.toc": toc, "Foo/special": "target" }, { "Foo/special": { unixMode } }),
        { flavor: "forever" },
      ),
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
  });
test("reject case collisions in files and inferred directories", async () => {
  const cases: Record<string, string>[] = [
    { "Foo/Foo.toc": toc, "Foo/a.lua": "a", "Foo/A.lua": "b" },
    { "Foo/Foo.toc": toc, "foo/a.lua": "a" },
  ];
  for (const files of cases)
    await expect(readArchive(await zip(files), { flavor: "forever" })).rejects.toMatchObject({
      code: "ARCHIVE_INVALID",
    });
});
test("entry and uncompressed size caps", async () => {
  const bytes = await zip({ "Foo/Foo.toc": toc, "Foo/large": "x".repeat(1000) });
  await expect(readArchive(bytes, { flavor: "forever", maxBytes: 100 })).rejects.toMatchObject({
    code: "ARCHIVE_INVALID",
  });
  await expect(readArchive(bytes, { flavor: "forever", maxEntries: 1 })).rejects.toMatchObject({
    code: "ARCHIVE_INVALID",
  });
  const oversized = bytes.slice();
  const data = new DataView(oversized.buffer);
  for (let i = 0; i < oversized.length - 28; i++)
    if (data.getUint32(i, true) === 0x02014b50) {
      data.setUint32(i + 24, 501 * 1024 * 1024, true);
      break;
    }
  await expect(readArchive(oversized, { flavor: "forever" })).rejects.toThrow("size limit");
});
test("invalid ZIP fails with a typed error", async () => {
  await expect(
    readArchive(new TextEncoder().encode("not zip"), { flavor: "forever" }),
  ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
});
