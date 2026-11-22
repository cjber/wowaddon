import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { availableArchiveBytes, readArchive as inspectArchive } from "./archive";
import { zip } from "./testing/helpers";

const toc = "## Interface: 16001\n";
async function readArchive(
  bytes: Uint8Array,
  options: Omit<Parameters<typeof inspectArchive>[1], "maxBytes"> & { maxBytes?: number },
) {
  return inspectArchive(bytes, { maxBytes: await availableArchiveBytes(tmpdir()), ...options });
}

async function withStaging(check: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "wowaddon-archive-test-"));
  try {
    await check(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
  await withStaging(async (dir) => {
    await archive.extract(dir);
    expect(await readdir(dir)).toEqual(["Foo"]);
    expect((await readdir(join(dir, "Foo"))).sort()).toEqual(["Foo.toc", "a.lua"]);
  });
});
test("a root-level file is not part of a like-named addon folder", async () => {
  const archive = await readArchive(await zip({ "Foo/Foo.toc": toc, FooX: "root" }), {
    flavor: "forever",
  });
  expect(archive.folders).toEqual(["Foo"]);
  await withStaging(async (dir) => {
    await archive.extract(dir);
    expect(await readdir(dir)).toEqual(["Foo"]);
    expect(await readdir(join(dir, "Foo"))).toEqual(["Foo.toc"]);
  });
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
  await withStaging(async (dir) => {
    await archive.extract(dir);
    expect(await readFile(join(dir, "Tweaks", "init.lua"), "utf8")).toBe("x");
  });
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
  await withStaging(async (dir) => {
    await archive.extract(dir);
    expect(await readdir(dir)).toEqual(["Foo"]);
    expect((await readdir(join(dir, "Foo"))).sort()).toEqual(["Foo.toc", "a.lua"]);
  });
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
test("entry count and available space limits", async () => {
  const bytes = await zip({ "Foo/Foo.toc": toc, "Foo/large": "x".repeat(1000) });
  await expect(readArchive(bytes, { flavor: "forever", maxBytes: 100 })).rejects.toMatchObject({
    code: "ARCHIVE_INVALID",
  });
  await expect(readArchive(bytes, { flavor: "forever", maxEntries: 1 })).rejects.toMatchObject({
    code: "ARCHIVE_INVALID",
  });
});
test("staging rechecks free space for the files it will write", async () => {
  let available = 0;
  const archive = await readArchive(
    await zip({
      "Foo/Foo.toc": toc,
      "Foreign/Foreign.toc": "## Interface: 11508",
      "Foreign/large": "x".repeat(1000),
    }),
    { flavor: "forever", availableBytes: async () => available },
  );
  await withStaging(async (dir) => {
    await expect(archive.extract(dir)).rejects.toThrow("available disk space");
    expect(await readdir(dir)).toEqual([]);
    available = toc.length;
    await archive.extract(dir);
    expect(await readdir(dir)).toEqual(["Foo"]);
  });
});

test("shared folder versions are taken from a compatible TOC", async () => {
  const archive = await readArchive(
    await zip({
      "Foo/Foo.toc": "## Interface: 11508\n## Version: v1",
      "Foo/Foo_Forever.toc": `${toc}## Version: v2`,
    }),
    { flavor: "forever" },
  );
  expect(archive.versions.get("foo")).toBe("v2");
});

test("extracts an archive larger than 500 MiB", async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add("Foo/Foo.toc", new TextReader(toc));
  const entryBytes = 8 * 1024 * 1024;
  const entries = 64;
  const payload = new Uint8Array(entryBytes);
  for (let i = 0; i < entries; i++)
    await writer.add(`Foo/tile-${i}.blp`, new Uint8ArrayReader(payload), { level: 1 });
  const archive = await readArchive(await writer.close(), { flavor: "forever" });
  await withStaging(async (dir) => {
    await archive.extract(dir);
    let total = 0;
    for (let i = 0; i < entries; i++) {
      const { size } = await stat(join(dir, "Foo", `tile-${i}.blp`));
      expect(size).toBe(entryBytes);
      total += size;
    }
    expect(total).toBeGreaterThan(500 * 1024 * 1024);
  });
}, 30_000);

test("rejects data larger than its declared entry size", async () => {
  const payload = "x".repeat(1000);
  const bytes = await zip(
    { "Foo/Foo.toc": toc, "Foo/lying.blp": payload },
    { "Foo/lying.blp": { dataDescriptor: false, level: 1 } },
  );
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstCentral = data.getUint32(bytes.length - 22 + 16, true);
  const secondCentral =
    firstCentral +
    46 +
    data.getUint16(firstCentral + 28, true) +
    data.getUint16(firstCentral + 30, true) +
    data.getUint16(firstCentral + 32, true);
  const local = data.getUint32(secondCentral + 42, true);
  // Both headers agree on the lie, so the metadata can only be disproved by inflating the data.
  data.setUint32(secondCentral + 24, payload.length - 1, true);
  data.setUint32(local + 22, payload.length - 1, true);
  const archive = await readArchive(bytes, { flavor: "forever" });
  await withStaging(async (dir) => {
    await expect(archive.extract(dir)).rejects.toMatchObject({
      code: "ARCHIVE_INVALID",
      message: expect.stringMatching(/size/i),
    });
  });
});

test("invalid ZIP fails with a typed error", async () => {
  await expect(
    readArchive(new TextEncoder().encode("not zip"), { flavor: "forever" }),
  ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
});
