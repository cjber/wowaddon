import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import * as service from "../service";
import { offline } from "../testing/helpers";
import type { Context, Flavor, Row } from "../types";
import { App } from "./App";

const context = (flavor: Flavor = "era"): Context => ({
  flavor,
  addonsDir: `/${flavor}/AddOns`,
  configDir: "/config",
  notices: [],
});
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
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
const quit = mock((_code: number) => {});
beforeEach(() => {
  offline();
  quit.mockClear();
  open = spyOn(service, "openContext").mockImplementation(async (opts) => context(opts.flavor));
  list = spyOn(service, "listRows").mockResolvedValue([row()]);
  add = spyOn(service, "addAddon").mockResolvedValue(row("Added", "current"));
  sync = spyOn(service, "syncAddons").mockResolvedValue([row("Foo", "current")]);
  remove = spyOn(service, "removeAddon").mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy();
  });
  setup = undefined;
  for (const spy of [open, list, add, sync, remove]) spy.mockRestore();
});
async function start(props: { flavor?: Flavor; addonsDir?: string } = {}) {
  setup = await testRender(<App {...props} onQuit={quit} />, { width: 100, height: 24 });
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
  const pending = deferred<void>();
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
    pending.resolve();
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
  sync.mockReturnValue(deferred<Row[]>().promise);
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
  remove.mockReturnValue(deferred<void>().promise);
  await start();
  await press("x");
  await press("y");
  await act(async () => {
    setup?.mockInput.pressCtrlC();
  });
  expect(quit).toHaveBeenCalledWith(130);
  expect(remove.mock.calls[0][2]?.signal?.aborted).toBe(true);
});
