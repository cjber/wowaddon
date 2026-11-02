import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdoptionPlan, Query } from "./service";
import {
  type AddonInfo,
  type Context,
  type Flavor,
  type Listing,
  type Row,
  type SourceKind,
  type SourceReport,
  WowaddonError,
} from "./types";

const context: Context = {
  flavor: "era",
  addonsDir: "/addons",
  configDir: "/config",
  backups: { dir: "/backups", keep: 5 },
  notices: [],
};

const openContextMock = mock(
  async (_opts: { flavor?: Flavor; addonsDir?: string; env?: NodeJS.ProcessEnv }) => context,
);
const listRowsMock = mock(
  async (_ctx: Context, _opts: { refresh: boolean; signal?: AbortSignal }): Promise<Row[]> => [],
);
const addAddonMock = mock(
  async (
    _ctx: Context,
    _input: string,
    _opts: { note?: string; install: boolean; adopt?: boolean; signal?: AbortSignal },
  ): Promise<Row> => okRow(),
);
const syncAddonsMock = mock(
  async (
    _ctx: Context,
    _opts: { ids?: string[]; adopt?: boolean; backup?: boolean; signal?: AbortSignal },
  ): Promise<{ rows: Row[]; backup?: string }> => ({ rows: [] }),
);
const removeAddonMock = mock(
  async (_ctx: Context, _id: string, _opts?: { dryRun?: boolean; signal?: AbortSignal }) => ({
    entry: okRow().entry,
    installed: okRow().installed,
    deleted: true,
  }),
);
const parseRefMock = mock((_input: string) => ({ kind: "gh" as const, ref: "owner/repo" }));
const listing: Listing = {
  ref: "cf:1735937",
  kind: "cf",
  name: "OpenMap",
  summary: "A parchment world map",
  authors: ["cjber"],
  downloads: 1200,
  updated: "2026-10-30T00:00:00Z",
  categories: ["Map & Minimap"],
  gameVersions: ["1.60.1"],
  flavors: ["forever"],
  url: "https://www.curseforge.com/wow/addons/openmap",
};
const okSources: SourceReport[] = [
  { kind: "cf", status: "ok", count: 1 },
  { kind: "wago", status: "skipped", count: 0, code: "KEY", message: "needs a key" },
];
const findAddonsMock = mock(
  async (
    _ctx: Context,
    _query: Query,
    _opts: { sources?: SourceKind[]; signal?: AbortSignal },
  ): Promise<{ results: Listing[]; sources: SourceReport[] }> => ({
    results: [listing],
    sources: okSources,
  }),
);
const addonInfoMock = mock(
  async (_ctx: Context, _ref: string): Promise<AddonInfo> => ({
    ...listing,
    version: "1.2.0",
    links: { website: listing.url },
    folders: ["OpenMap"],
    description: "Maps.",
    changelog: { version: "1.2.0", text: "- fixed zoom" },
  }),
);
const listCategoriesMock = mock(async () => ({
  categories: [{ kind: "cf" as const, id: "6", name: "Map & Minimap", parent: "Addons" }],
  sources: [{ kind: "cf" as const, status: "ok" as const, count: 1 }],
}));
const listUntrackedMock = mock(
  async (_ctx: Context): Promise<{ folder: string; title?: string; toc: string }[]> => [],
);
const adoptAddonsMock = mock(
  async (
    _ctx: Context,
    _opts: { wowup?: string | false; dryRun?: boolean; backup?: boolean },
  ): Promise<{ plan: AdoptionPlan; rows: Row[]; backup?: string }> => ({
    plan: {
      wowup: { path: "/wowup", installation: "World of Warcraft: Forever" },
      matches: [
        {
          entry: { id: "cf:301", kind: "cf", ref: "301", note: "Atlas" },
          folders: ["Atlas"],
          matchedBy: "toc",
          inManifest: false,
          conflicts: [],
        },
      ],
      unmatched: [{ folder: "Mystery", reason: "no match" }],
      skipped: [{ folder: "Dev", reason: "dev link, never touched" }],
    },
    rows: [],
  }),
);

// mock.module patches the module registry process-wide, not just for this file, so capture
// the real module first and put it back once this file's tests finish.
const realService = { ...(await import("./service")) };

mock.module("./service", () => ({
  openContext: openContextMock,
  listRows: listRowsMock,
  addAddon: addAddonMock,
  syncAddons: syncAddonsMock,
  removeAddon: removeAddonMock,
  parseRef: parseRefMock,
  findAddons: findAddonsMock,
  addonInfo: addonInfoMock,
  listCategories: listCategoriesMock,
  listUntracked: listUntrackedMock,
  adoptAddons: adoptAddonsMock,
}));

const { runCli } = await import("./cli");
const EXPECTED_COMMANDS = [
  "sync",
  "check",
  "add",
  "remove",
  "list",
  "search",
  "browse",
  "info",
  "categories",
  "adopt",
  "schema",
];

afterAll(() => {
  mock.module("./service", () => realService);
});

function okRow(overrides: Partial<Row> = {}): Row {
  return {
    entry: { id: "cf:6124", kind: "cf", ref: "6124", note: "Auctionator" },
    installed: { version: "11.0.3", versionKey: "1", folders: ["Auctionator"], installedAt: "now" },
    status: "current",
    ...overrides,
  };
}

function errorRow(): Row {
  return {
    entry: { id: "gh:owner/repo", kind: "gh", ref: "owner/repo" },
    status: "error",
    message: "network unreachable",
  };
}

let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  logs = [];
  errs = [];
  originalLog = console.log;
  originalWrite = process.stderr.write;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errs.push(String(chunk).replace(/\n$/, ""));
    return true;
  }) as typeof process.stderr.write;
  openContextMock.mockClear();
  listRowsMock.mockClear();
  addAddonMock.mockClear();
  syncAddonsMock.mockClear();
  removeAddonMock.mockClear();
  parseRefMock.mockClear();
  for (const m of [
    findAddonsMock,
    addonInfoMock,
    listCategoriesMock,
    listUntrackedMock,
    adoptAddonsMock,
  ])
    m.mockClear();
  listUntrackedMock.mockImplementation(async () => []);
  openContextMock.mockImplementation(async () => context);
  listRowsMock.mockImplementation(async () => []);
  addAddonMock.mockImplementation(async () => okRow());
  syncAddonsMock.mockImplementation(async () => ({ rows: [] }));
  removeAddonMock.mockImplementation(async () => ({
    entry: okRow().entry,
    installed: okRow().installed,
    deleted: true,
  }));
});

afterEach(() => {
  console.log = originalLog;
  process.stderr.write = originalWrite;
});

describe("global flags", () => {
  test("--help prints usage and exits 0", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
  });

  test("-V prints the version and exits 0", async () => {
    expect(await runCli(["-V"])).toBe(0);
    expect(logs[0]).toContain("wowaddon");
  });

  test("rejects an invalid --flavor", async () => {
    expect(await runCli(["--flavor", "wrath", "list"])).toBe(2);
    expect(errs.join("\n")).toContain("--flavor");
  });

  test("unknown command is a usage error", async () => {
    expect(await runCli(["frobnicate"])).toBe(2);
  });

  test("unknown option is a usage error", async () => {
    expect(await runCli(["list", "--bogus"])).toBe(2);
  });
});

describe("sync", () => {
  test("prints OK lines and exits 0 on success", async () => {
    syncAddonsMock.mockImplementation(async () => ({ rows: [okRow()] }));
    const code = await runCli(["sync"]);
    expect(code).toBe(0);
    expect(logs[0]).toBe("OK   cf:6124 Auctionator 11.0.3");
  });

  test("exits 1 when any row failed", async () => {
    syncAddonsMock.mockImplementation(async () => ({ rows: [okRow(), errorRow()] }));
    const code = await runCli(["sync"]);
    expect(code).toBe(1);
    expect(logs.some((l) => l.startsWith("FAIL"))).toBe(true);
  });

  test("passes positional ids and --adopt through", async () => {
    await runCli(["sync", "cf:6124", "--adopt"]);
    const call = syncAddonsMock.mock.calls[0][1] as { ids?: string[]; adopt?: boolean };
    expect(call.ids).toEqual(["cf:6124"]);
    expect(call.adopt).toBe(true);
  });

  test("a dev-link skip still exits 0", async () => {
    syncAddonsMock.mockImplementation(async () => ({
      rows: [
        {
          entry: { id: "gh:a/b", kind: "gh", ref: "a/b" },
          status: "dev",
          message: "dev link, skipped",
        },
      ],
    }));
    const code = await runCli(["sync"]);
    expect(code).toBe(0);
    expect(logs[0]).toBe("SKIP gh:a/b dev link, skipped");
  });
});

describe("add", () => {
  test("requires a ref", async () => {
    expect(await runCli(["add"])).toBe(2);
  });

  test("joins kind + ref into one input and installs by default", async () => {
    await runCli(["add", "gh", "owner/repo"]);
    expect(addAddonMock.mock.calls[0][1]).toBe("gh owner/repo");
    const opts = addAddonMock.mock.calls[0][2] as { install: boolean };
    expect(opts.install).toBe(true);
  });

  test("--no-install disables install", async () => {
    await runCli(["add", "owner/repo", "--no-install"]);
    const opts = addAddonMock.mock.calls[0][2] as { install: boolean };
    expect(opts.install).toBe(false);
  });

  test("--note is forwarded", async () => {
    await runCli(["add", "owner/repo", "--note", "quest helper"]);
    const opts = addAddonMock.mock.calls[0][2] as { note?: string };
    expect(opts.note).toBe("quest helper");
  });

  test("a failed add exits 1", async () => {
    addAddonMock.mockImplementation(async () => errorRow());
    const code = await runCli(["add", "owner/repo"]);
    expect(code).toBe(1);
  });
});

describe("remove", () => {
  test("requires an id", async () => {
    expect(await runCli(["remove"])).toBe(2);
  });

  test("removes and exits 0", async () => {
    const code = await runCli(["remove", "cf:6124"]);
    expect(code).toBe(0);
    expect(removeAddonMock.mock.calls[0][1]).toBe("cf:6124");
  });

  test("passes the abort signal through", async () => {
    await runCli(["remove", "cf:6124"]);
    expect(removeAddonMock.mock.calls[0][2]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("list", () => {
  test("plain output", async () => {
    listRowsMock.mockImplementation(async () => [okRow()]);
    const code = await runCli(["list"]);
    expect(code).toBe(0);
    expect(logs[0]).toContain("cf:6124");
  });

  test("--json prints one envelope with the rows", async () => {
    listRowsMock.mockImplementation(async () => [okRow()]);
    expect(await runCli(["list", "--json"])).toBe(0);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({
      schemaVersion: 1,
      command: "list",
      flavor: "era",
      addonsDir: "/addons",
      addons: [okRow()],
    });
  });

  test("--refresh is forwarded", async () => {
    await runCli(["list", "--refresh"]);
    const call = listRowsMock.mock.calls[0][1] as { refresh: boolean };
    expect(call.refresh).toBe(true);
  });
});

describe("check and dry runs", () => {
  const update = okRow({
    status: "update",
    latest: { version: "12", versionKey: "2", url: "https://x", archive: "package" },
  });

  test("check refreshes, lists only what is not current and counts updates", async () => {
    listRowsMock.mockImplementation(async () => [okRow(), update]);
    expect(await runCli(["check"])).toBe(0);
    expect(listRowsMock.mock.calls[0][1]).toMatchObject({ refresh: true, ids: [] });
    expect(logs).toEqual(["UPDATE    cf:6124 Auctionator 11.0.3 -> 12"]);
    await runCli(["check", "--json"]);
    expect(JSON.parse(logs[1])).toMatchObject({ command: "check", updates: 1 });
  });

  test("check says when everything is current", async () => {
    listRowsMock.mockImplementation(async () => [okRow()]);
    await runCli(["check"]);
    expect(logs).toEqual(["all 1 addons are current"]);
  });

  test("sync --dry-run previews the selected ids through the sync path", async () => {
    syncAddonsMock.mockImplementation(async () => ({ rows: [update] }));
    expect(await runCli(["sync", "cf:6124", "--dry-run", "--adopt", "--json"])).toBe(0);
    expect(listRowsMock).not.toHaveBeenCalled();
    expect(syncAddonsMock.mock.calls[0][1]).toMatchObject({
      ids: ["cf:6124"],
      dryRun: true,
      adopt: true,
    });
    expect(JSON.parse(logs[0])).toMatchObject({ dryRun: true, backup: null, addons: [update] });
  });

  test("sync reports its backup and --no-backup turns it off", async () => {
    syncAddonsMock.mockImplementation(async () => ({ rows: [okRow()], backup: "/b/WTF.zip" }));
    await runCli(["sync", "--json"]);
    expect(JSON.parse(logs[0])).toMatchObject({ dryRun: false, backup: "/b/WTF.zip" });
    expect(errs).toContain("Backed up WTF to /b/WTF.zip");
    expect(syncAddonsMock.mock.calls[0][1].backup).toBe(true);
    await runCli(["sync", "--no-backup"]);
    expect(syncAddonsMock.mock.calls[1][1].backup).toBe(false);
  });

  test("add and remove forward --dry-run", async () => {
    await runCli(["add", "owner/repo", "--dry-run"]);
    expect(addAddonMock.mock.calls[0][2]).toMatchObject({ dryRun: true, install: true });
    removeAddonMock.mockImplementation(async () => ({
      entry: okRow().entry,
      installed: okRow().installed,
      deleted: false,
    }));
    await runCli(["remove", "cf:6124", "--dry-run"]);
    expect(removeAddonMock.mock.calls[0][2]?.dryRun).toBe(true);
    expect(logs[1]).toBe("WOULD remove cf:6124; Auctionator stays (dev link)");
  });
});

describe("schema and JSON errors", () => {
  test("schema describes every command, the statuses and the exit codes", async () => {
    expect(await runCli(["schema"])).toBe(0);
    const doc = JSON.parse(logs.join("\n"));
    expect(Object.keys(doc.commands)).toEqual(EXPECTED_COMMANDS);
    expect(doc.commands.sync.usage).toBe(
      "wowaddon sync [<id|ref>...] [--adopt] [--dry-run] [--no-backup]",
    );
    expect(doc.exitCodes.locked.code).toBe(3);
    expect(Object.keys(doc.statuses)).toContain("dev");
    expect(openContextMock).not.toHaveBeenCalled();
  });

  test("help lists the new commands", async () => {
    await runCli(["--help"]);
    expect(logs.join("\n")).toContain("wowaddon check [<id|ref>...]");
  });

  test("a typed error becomes a JSON error with its code", async () => {
    syncAddonsMock.mockImplementation(async () => {
      throw new WowaddonError("LOCKED", "Another wowaddon operation is running.");
    });
    expect(await runCli(["sync", "--json"])).toBe(3);
    expect(JSON.parse(logs[0])).toEqual({
      schemaVersion: 1,
      command: "sync",
      error: { code: "LOCKED", message: "Another wowaddon operation is running." },
    });
  });

  test("usage and config errors are JSON with exit 2", async () => {
    expect(await runCli(["list", "--bogus", "--json"])).toBe(2);
    expect(JSON.parse(logs[0]).error.code).toBe("USAGE");
    openContextMock.mockImplementation(async () => {
      throw new WowaddonError("CONFIG_MISSING", "No AddOns directory found.");
    });
    expect(await runCli(["--json", "list"])).toBe(2);
    expect(JSON.parse(logs[1]).error.code).toBe("CONFIG_MISSING");
  });
});

describe("context failures", () => {
  test("an openContext failure exits 2", async () => {
    openContextMock.mockImplementation(async () => {
      throw new Error("ambiguous AddOns folder");
    });
    const code = await runCli(["list"]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("ambiguous AddOns folder");
  });

  test("a mutation failure after context succeeds exits 1", async () => {
    syncAddonsMock.mockImplementation(async () => {
      throw new Error("disk full");
    });
    const code = await runCli(["sync"]);
    expect(code).toBe(1);
  });
});

describe("TTY dispatch", () => {
  test("bare invocation on a TTY returns undefined for the TUI", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      expect(await runCli([])).toBeUndefined();
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    }
  });

  test("bare invocation off a TTY runs sync", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      syncAddonsMock.mockImplementation(async () => ({ rows: [okRow()] }));
      expect(await runCli([])).toBe(0);
      expect(syncAddonsMock).toHaveBeenCalledTimes(1);
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    }
  });
});

describe("context notices", () => {
  test("notices are printed to stderr", async () => {
    openContextMock.mockImplementation(async () => ({
      ...context,
      notices: ["migrated addons.txt to era.txt"],
    }));
    await runCli(["list"]);
    expect(errs).toContain("migrated addons.txt to era.txt");
  });
});

describe("finding addons", () => {
  test("search passes the query and flags, and reports skipped sources on stderr", async () => {
    expect(
      await runCli([
        "search",
        "world",
        "map",
        "--sort",
        "downloads",
        "--source",
        "cf",
        "--limit",
        "5",
        "--json",
      ]),
    ).toBe(0);
    const [, query, opts] = findAddonsMock.mock.calls[0];
    expect(query).toMatchObject({ text: "world map", order: "downloads", limit: 5, page: 1 });
    expect(opts.sources).toEqual(["cf"]);
    expect(JSON.parse(logs[0])).toMatchObject({
      schemaVersion: 1,
      command: "search",
      query: "world map",
      results: [{ ref: "cf:1735937" }],
      sources: okSources,
    });
    expect(errs).toContain("wago skipped: needs a key");
  });

  test("search needs words and a known sort", async () => {
    expect(await runCli(["search"])).toBe(2);
    expect(await runCli(["search", "x", "--sort", "stars"])).toBe(2);
  });

  test("search exits 1 when every source failed", async () => {
    findAddonsMock.mockImplementationOnce(async () => ({
      results: [],
      sources: [{ kind: "cf", status: "failed", count: 0, message: "down" }],
    }));
    expect(await runCli(["search", "x"])).toBe(1);
    expect(logs).toEqual(["no addons found"]);
  });

  test("browse maps its mode to an order and rejects unknown modes", async () => {
    await runCli(["browse", "--category", "map"]);
    expect(findAddonsMock.mock.calls[0][1]).toMatchObject({ order: "downloads", category: "map" });
    await runCli(["browse", "trending", "--json"]);
    expect(findAddonsMock.mock.calls[1][1].order).toBe("trending");
    expect(JSON.parse(logs[1])).toMatchObject({ command: "browse", mode: "trending" });
    expect(await runCli(["browse", "hot"])).toBe(2);
  });

  test("info prints the details and its JSON carries the addon", async () => {
    expect(await runCli(["info", "cf:1735937"])).toBe(0);
    expect(addonInfoMock.mock.calls[0][1]).toBe("cf:1735937");
    expect(logs.join("\n")).toContain("changelog 1.2.0:");
    await runCli(["info", "cf:1735937", "--json"]);
    expect(JSON.parse(logs.at(-1) ?? "")).toMatchObject({
      command: "info",
      addon: { folders: ["OpenMap"] },
    });
    expect(await runCli(["info"])).toBe(2);
  });

  test("categories lists each source's categories", async () => {
    expect(await runCli(["categories"])).toBe(0);
    expect(logs).toEqual(["cf     Addons / Map & Minimap"]);
  });
});

describe("adopt", () => {
  test("a dry run lists matches, unmatched and skipped folders", async () => {
    expect(await runCli(["adopt", "--dry-run", "--no-wowup"])).toBe(0);
    expect(adoptAddonsMock.mock.calls[0][1]).toMatchObject({
      dryRun: true,
      wowup: false,
      backup: true,
    });
    expect(logs).toEqual([
      "WOULD adopt cf:301 Atlas [Atlas] by toc",
      "UNMATCHED Mystery: no match",
      "SKIP Dev: dev link, never touched",
    ]);
  });

  test("adopt forwards --wowup and --no-backup and reports the backup", async () => {
    adoptAddonsMock.mockImplementationOnce(async () => ({
      plan: { wowup: null, matches: [], unmatched: [], skipped: [] },
      rows: [okRow()],
      backup: "/b/WTF.zip",
    }));
    await runCli(["adopt", "--wowup", "/data/WowUp", "--no-backup", "--json"]);
    expect(adoptAddonsMock.mock.calls[0][1]).toMatchObject({ wowup: "/data/WowUp", backup: false });
    expect(JSON.parse(logs[0])).toMatchObject({
      command: "adopt",
      backup: "/b/WTF.zip",
      addons: [okRow()],
    });
    expect(errs).toContain("Backed up WTF to /b/WTF.zip");
  });

  test("check lists untracked folders, and leaves them out for named ids", async () => {
    listUntrackedMock.mockImplementation(async () => [
      { folder: "Atlas", title: "Atlas", toc: "" },
    ]);
    await runCli(["check", "--json"]);
    expect(JSON.parse(logs[0]).untracked).toEqual([{ folder: "Atlas", title: "Atlas" }]);
    await runCli(["check"]);
    expect(logs.slice(1, 3)).toEqual([
      "all 0 addons are current",
      "UNTRACKED Atlas (Atlas): wowaddon adopt takes it over",
    ]);
    await runCli(["check", "cf:6124", "--json"]);
    expect(JSON.parse(logs.at(-1) ?? "").untracked).toEqual([]);
  });
});
