import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import * as service from "../service";
import { offline } from "../testing/helpers";
import type { Context, Flavor, Listing, Row } from "../types";
import { App } from "./App";

const context = (flavor: Flavor = "era"): Context => ({
  flavor,
  addonsDir: `/${flavor}/AddOns`,
  configDir: "/config",
  backups: { dir: "/backups", keep: 5 },
  notices: [],
});
const listings = (count = 3): Listing[] =>
  Array.from({ length: count }, (_, i) => ({
    ref: `cf:${100 + i}`,
    kind: "cf" as const,
    name: `Map${i}`,
    summary: `map addon ${i}`,
    authors: ["someone"],
    downloads: 1000 * (i + 1),
    updated: "2026-10-01T00:00:00Z",
    categories: [i % 2 ? "Bags" : "Map & Minimap"],
    gameVersions: ["1.15.7"],
    flavors: ["era" as const],
    url: "https://example.com",
  }));
const row = (name = "Foo", status: Row["status"] = "missing"): Row => ({
  entry: {
    id: `gh:a/${name.toLowerCase()}`,
    kind: "gh",
    ref: `a/${name.toLowerCase()}`,
    note: name,
  },
  status,
});
function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}
let open: ReturnType<typeof spyOn<typeof service, "openContext">>;
let list: ReturnType<typeof spyOn<typeof service, "listRows">>;
let add: ReturnType<typeof spyOn<typeof service, "addAddon">>;
let sync: ReturnType<typeof spyOn<typeof service, "syncAddons">>;
let remove: ReturnType<typeof spyOn<typeof service, "removeAddon">>;
let find: ReturnType<typeof spyOn<typeof service, "findAddons">>;
let info: ReturnType<typeof spyOn<typeof service, "addonInfo">>;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
const quit = mock((_code: number) => {});
beforeEach(() => {
  offline();
  quit.mockClear();
  open = spyOn(service, "openContext").mockImplementation(async (opts) => context(opts.flavor));
  list = spyOn(service, "listRows").mockResolvedValue([row()]);
  add = spyOn(service, "addAddon").mockResolvedValue(row("Added", "current"));
  sync = spyOn(service, "syncAddons").mockResolvedValue({ rows: [row("Foo", "current")] });
  remove = spyOn(service, "removeAddon").mockResolvedValue({ entry: row().entry, deleted: true });
  find = spyOn(service, "findAddons").mockResolvedValue({ results: listings(), sources: [] });
  info = spyOn(service, "addonInfo").mockImplementation(async (_ctx, ref) => ({
    ...(listings().find((l) => l.ref === ref) ?? listings()[0]),
    version: "2.0",
    links: {},
    folders: ["Map"],
    description: "Long description.",
    changelog: { version: "2.0", text: "- new zoom" },
  }));
});
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy();
  });
  setup = undefined;
  for (const spy of [open, list, add, sync, remove, find, info]) spy.mockRestore();
});
async function start(
  props: { flavor?: Flavor; addonsDir?: string } = {},
  width = 100,
  height = 24,
) {
  setup = await testRender(<App {...props} onQuit={quit} />, { width, height });
  await frame();
  return setup;
}
async function frame() {
  await act(async () => {
    await setup?.renderOnce();
  });
  return setup?.captureCharFrame() ?? "";
}
async function press(key: string) {
  await act(async () => {
    setup?.mockInput.pressKey(key);
  });
  return frame();
}
async function enterAdd() {
  await press("a");
  await act(async () => {
    await setup?.mockInput.typeText("a/added");
  });
}

test("Enter submits an add once and action keys cannot start concurrent mutations", async () => {
  const pending = deferred<Row>();
  add.mockReturnValue(pending.promise);
  await start();
  await enterAdd();
  await press("RETURN");
  expect(add).toHaveBeenCalledTimes(1);
  await press("RETURN");
  await press("ESCAPE");
  await press("U");
  expect(add).toHaveBeenCalledTimes(1);
  expect(sync).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve(row("Added", "current"));
  });
  expect(await frame()).toContain("Added");
});

test("repeated confirmation keys start only one removal", async () => {
  const pending = deferred<service.Removal>();
  remove.mockReturnValue(pending.promise);
  await start();
  await press("x");
  await act(async () => {
    setup?.mockInput.pressKey("y");
    setup?.mockInput.pressKey("y");
  });
  expect(remove).toHaveBeenCalledTimes(1);
  await press("y");
  expect(remove).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve({ entry: row().entry, deleted: true });
  });
});

test("switching context aborts refresh and discards its late rows", async () => {
  const old = deferred<Row[]>();
  let signal: AbortSignal | undefined;
  list.mockImplementation(async (ctx, opts) => {
    if (ctx.flavor === "era" && opts.refresh) {
      signal = opts.signal;
      return old.promise;
    }
    return [row(ctx.flavor)];
  });
  await start();
  await press("f");
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    old.resolve([row("Stale")]);
  });
  const output = await frame();
  expect(output).toContain("forever · /forever/AddOns");
  expect(output).toContain("gh:a/forever");
  expect(output).not.toContain("Stale");
});

test("a mutation invalidates refreshes that would overwrite its rows", async () => {
  const old = deferred<Row[]>();
  let signal: AbortSignal | undefined;
  list.mockImplementation(async (_ctx, opts) => {
    if (opts.refresh) {
      signal = opts.signal;
      return old.promise;
    }
    return [row()];
  });
  await start();
  await press("u");
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    old.resolve([row("Stale")]);
  });
  const output = await frame();
  expect(output).toContain("up to date");
  expect(output).not.toContain("Stale");
});

for (const failure of ["open", "list"] as const) {
  test(`failed flavor ${failure} keeps the old flavor, rows and context actionable`, async () => {
    await start();
    if (failure === "open") open.mockRejectedValue(new Error("cannot load forever"));
    else
      list.mockImplementation(async (ctx) => {
        if (ctx.flavor === "forever") throw new Error("cannot load forever");
        return [row()];
      });
    const output = await press("f");
    expect(output).toContain("era · /era/AddOns");
    expect(output).toContain("cannot load forever");
    expect(output).toContain("Foo");
    await press("u");
    expect(sync.mock.calls[0][0].flavor).toBe("era");
  });
}

test("directory override follows the initially resolved flavor through a round trip", async () => {
  open.mockImplementation(async (opts) => ({
    ...context(opts.flavor ?? "forever"),
    addonsDir: opts.addonsDir ?? `/${opts.flavor}/AddOns`,
  }));
  await start({ addonsDir: "/custom" });
  expect(await frame()).toContain("forever · /custom");
  await press("f");
  expect(open.mock.calls[1][0]).toMatchObject({ flavor: "era", addonsDir: undefined });
  await press("f");
  expect(open.mock.calls[2][0]).toMatchObject({ flavor: "forever", addonsDir: "/custom" });
  expect(await frame()).toContain("forever · /custom");
});

for (const mode of ["list", "add", "remove", "adopt", "help"] as const) {
  test(`Ctrl+C exits 130 from ${mode} and aborts outstanding refresh`, async () => {
    const pending = deferred<Row[]>();
    let signal: AbortSignal | undefined;
    list.mockImplementation(async (_ctx, opts) => {
      if (opts.refresh) {
        signal = opts.signal;
        return pending.promise;
      }
      return [row("Foo", "unmanaged")];
    });
    await start();
    const keys = { list: "", add: "a", remove: "x", adopt: "u", help: "?" };
    if (keys[mode]) await press(keys[mode]);
    await act(async () => {
      setup?.mockInput.pressCtrlC();
    });
    expect(quit).toHaveBeenCalledWith(130);
    expect(signal?.aborted).toBe(true);
  });
}

test("Ctrl+C aborts an active add; q exits active sync with code zero", async () => {
  add.mockReturnValue(deferred<Row>().promise);
  await start();
  await enterAdd();
  await press("RETURN");
  await act(async () => {
    setup?.mockInput.pressCtrlC();
  });
  expect(quit).toHaveBeenCalledWith(130);
  expect(add.mock.calls[0][2].signal?.aborted).toBe(true);
  await act(async () => {
    setup?.renderer.destroy();
  });
  sync.mockReturnValue(deferred<{ rows: Row[] }>().promise);
  await start();
  await press("u");
  await press("q");
  expect(quit).toHaveBeenLastCalledWith(0);
  expect(sync.mock.calls[0][1].signal?.aborted).toBe(true);
});

test("40 addons fit in 100x24 with clipping indicators, footer and selected row visible", async () => {
  list.mockResolvedValue(
    Array.from({ length: 40 }, (_, i) => row(`Addon${i.toString().padStart(2, "0")}`)),
  );
  await start();
  let output = await frame();
  expect(output).toMatch(/↓ \d+ more/);
  expect(output).toContain("u update  U all");
  for (let i = 0; i < 39; i++) await press("ARROW_DOWN");
  output = await frame();
  expect(output).toContain("› Addon39");
  expect(output).toContain("gh:a/addon39");
  expect(output).toMatch(/↑ \d+ more/);
  expect(output).toContain("u update  U all");
  const marker = setup
    ?.captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("more"));
  expect((marker?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
  await act(async () => {
    setup?.resize(100, 16);
  });
  output = await frame();
  expect(output).toContain("› Addon39");
  expect(output).toContain("u update  U all");
});

test("Ctrl+C also aborts an active removal", async () => {
  remove.mockReturnValue(deferred<service.Removal>().promise);
  await start();
  await press("x");
  await press("y");
  await act(async () => {
    setup?.mockInput.pressCtrlC();
  });
  expect(quit).toHaveBeenCalledWith(130);
  expect(remove.mock.calls[0][2]?.signal?.aborted).toBe(true);
});

const lineOf = (output: string, text: string) =>
  output.split("\n").findIndex((line) => line.includes(text));

test("browse loads trending once, groups by category and installs with one key", async () => {
  add.mockImplementation(async (_ctx, ref) => ({
    ...row("Map0", "current"),
    entry: { id: ref, kind: "cf", ref: ref.slice(3), note: "Map0" },
  }));
  await start();
  let output = await press("TAB");
  expect(find).toHaveBeenCalledTimes(1);
  expect(find.mock.calls[0][1]).toMatchObject({ order: "trending", page: 1 });
  output = await frame();
  expect(output).toContain("wowaddon · browse · era · trending");
  expect(output).toContain("▾ Map & Minimap 2");
  expect(output).toContain("▾ Bags 1");
  await press("RETURN");
  output = await frame();
  expect(info.mock.calls[0][1]).toBe("cf:100");
  expect(output).toContain("changelog 2.0: - new zoom");
  await press("i");
  expect(add.mock.calls[0]).toMatchObject([
    expect.anything(),
    "cf:100",
    { note: "Map0", install: true },
  ]);
  output = await frame();
  expect(output).toContain("✓ Map0");
  await press("TAB");
  await press("TAB");
  expect(find).toHaveBeenCalledTimes(1);
});

test("an install stopped by an unmanaged folder is taken over by rerunning the add with adopt", async () => {
  add.mockImplementation(async (_ctx, ref, opts) => ({
    ...row("Map0", opts.adopt ? "current" : "unmanaged"),
    entry: { id: ref, kind: "cf", ref: ref.slice(3), note: "Map0" },
  }));
  list.mockResolvedValue([]);
  await start();
  await press("TAB");
  await press("RETURN");
  let output = await press("i");
  expect(output).toContain("Map0 is installed outside wowaddon · u takes it over");
  expect(output).not.toContain("installed Map0");
  await press("TAB");
  await press("u");
  await press("y");
  expect(sync).not.toHaveBeenCalled();
  expect(add.mock.calls[1]).toMatchObject([
    expect.anything(),
    "cf:100",
    { note: "Map0", install: true, adopt: true },
  ]);
  output = await frame();
  expect(output).toContain("installed Map0");
});

test("/ searches by best match, o cycles the sort and h folds a group", async () => {
  await start();
  await press("TAB");
  await press("/");
  await act(async () => {
    await setup?.mockInput.typeText("questie");
  });
  await press("RETURN");
  expect(find.mock.calls[1][1]).toMatchObject({ text: "questie", order: "relevance", page: 1 });
  expect(await frame()).toContain('"questie" · best match');
  await press("o");
  expect(find.mock.calls[2][1]).toMatchObject({ text: "questie", order: "downloads" });
  await press("n");
  expect(find.mock.calls[3][1]).toMatchObject({ order: "downloads", page: 2 });
  await press("h");
  expect(await frame()).toContain("▸ Map & Minimap 2");
  expect(await frame()).not.toContain("Map0  ");
});

test("switching views keeps the page height and each view's scroll position", async () => {
  list.mockResolvedValue(
    Array.from({ length: 40 }, (_, i) => row(`Addon${i.toString().padStart(2, "0")}`)),
  );
  find.mockResolvedValue({ results: listings(30), sources: [] });
  await start();
  for (let i = 0; i < 25; i++) await press("j");
  const installed = await frame();
  const keysRow = lineOf(installed, "q quit");
  const statusRow = keysRow - 1;
  await press("TAB");
  await press("END");
  const browse = await frame();
  expect(lineOf(browse, "q quit")).toBe(keysRow);
  expect(browse.split("\n").length).toBe(installed.split("\n").length);
  await press("TAB");
  expect(await frame()).toBe(installed);
  expect(lineOf(installed, "› Addon25")).toBeLessThan(statusRow);
  await press("TAB");
  expect(await frame()).toBe(browse);
});

const keysOf = (output: string) =>
  output
    .split("\n")
    .filter(
      (line) => line.includes("quit") || line.includes("u update") || line.includes("/ search"),
    );

for (const width of [110, 80] as const) {
  test(`at ${width} columns the keys line ${width === 110 ? "is one line" : "wraps with quit beside help"} in both views`, async () => {
    list.mockResolvedValue([row("Foo", "current")]);
    await start({}, width, 24);
    const installed = await frame();
    await press("TAB");
    const browse = await frame();
    for (const [output, first] of [
      [installed, "u update"],
      [browse, "/ search"],
    ] as const) {
      const quitLine = output.split("\n")[lineOf(output, "q quit")];
      expect(quitLine).toContain("? help  q quit");
      if (width === 110) expect(quitLine).toContain(first);
      else expect(quitLine).not.toContain(first);
      // The footer is the same height in both views, so the keys start on the same row.
      expect(lineOf(output, first)).toBe(lineOf(installed, "u update"));
    }
    expect(keysOf(installed).length).toBe(width === 110 ? 1 : 2);
  });
}

test("the installed pane lists the selected addon's facts in palette colours", async () => {
  list.mockResolvedValue([
    {
      ...row("Foo", "update"),
      installed: {
        version: "1.0",
        versionKey: "1",
        folders: ["Foo", "Foo_Options"],
        installedAt: "2026-10-20T09:00:00Z",
      },
      latest: {
        version: "1.1",
        versionKey: "2",
        url: "https://example.com",
        archive: "package",
        note: "beta",
      },
    },
  ]);
  await start({}, 110, 24);
  const output = await frame();
  expect(output).toContain("Foo  gh:a/foo");
  expect(output).toMatch(/status +update available/);
  expect(output).toMatch(/version +1\.0/);
  expect(output).toMatch(/latest +1\.1 beta/);
  expect(output).toMatch(/installed +2026-10-20/);
  expect(output).toMatch(/folders +Foo, Foo_Options/);
  const spans = setup?.captureSpans().lines.flatMap((line) => line.spans) ?? [];
  const span = (text: string) => spans.find((s) => s.text.trim() === text);
  expect(span("gh")?.fg).not.toEqual(span("update available")?.fg);
  expect(span("q")?.fg).toEqual(span("u")?.fg);
  expect((span("quit")?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
});
