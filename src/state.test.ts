import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readState, statePath, writeState } from "./state";
import { tempContext } from "./testing/helpers";

let fixture: Awaited<ReturnType<typeof tempContext>>;
beforeEach(async () => {
  fixture = await tempContext();
});
afterEach(async () => {
  await fixture.cleanup();
});
test("missing state is empty; writes are atomic", async () => {
  const state = await readState(fixture.ctx);
  expect(state.addons).toEqual({});
  state.addons["gh:a/b"] = { version: "v1", versionKey: "1", folders: ["Foo"], installedAt: "now" };
  await writeState(fixture.ctx, state);
  expect(await readState(fixture.ctx)).toEqual(state);
  expect(await readdir(dirname(statePath(fixture.ctx)))).toEqual(["forever.json"]);
});
for (const data of ["not json", '{"schema":2}', '{"schema":1,"addonsDir":"x","addons":null}'])
  test(`corrupt state blocks: ${data}`, async () => {
    await mkdir(dirname(statePath(fixture.ctx)), { recursive: true });
    await writeFile(statePath(fixture.ctx), data);
    await expect(readState(fixture.ctx)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
  });
test("destination mismatch blocks", async () => {
  await mkdir(dirname(statePath(fixture.ctx)), { recursive: true });
  await writeFile(
    statePath(fixture.ctx),
    JSON.stringify({ schema: 1, addonsDir: "/somewhere/else", addons: {} }),
  );
  await expect(readState(fixture.ctx)).rejects.toMatchObject({ code: "STATE_DESTINATION" });
});
test("unsafe folders and case-insensitive ownership duplicates block", async () => {
  const state = await readState(fixture.ctx);
  state.addons["cf:1"] = {
    version: "v1",
    versionKey: "1",
    folders: ["../Escape"],
    installedAt: "now",
  };
  await expect(writeState(fixture.ctx, state)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
  state.addons["cf:1"].folders = ["Foo", "foo"];
  await expect(writeState(fixture.ctx, state)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
});
