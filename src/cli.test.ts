import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context, Flavor, Row } from "./types";

const context: Context = { flavor: "era", addonsDir: "/addons", configDir: "/config", notices: [] };

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
    _opts: { ids?: string[]; adopt?: boolean; signal?: AbortSignal },
  ): Promise<Row[]> => [],
);
const removeAddonMock = mock(
  async (_ctx: Context, _id: string, _opts?: { signal?: AbortSignal }) => {},
);
const parseRefMock = mock((_input: string) => ({ kind: "gh" as const, ref: "owner/repo" }));

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
}));

const { runCli } = await import("./cli");

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
  openContextMock.mockImplementation(async () => context);
  listRowsMock.mockImplementation(async () => []);
  addAddonMock.mockImplementation(async () => okRow());
  syncAddonsMock.mockImplementation(async () => []);
  removeAddonMock.mockImplementation(async () => {});
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
    syncAddonsMock.mockImplementation(async () => [okRow()]);
    const code = await runCli(["sync"]);
    expect(code).toBe(0);
    expect(logs[0]).toBe("OK   cf:6124 Auctionator 11.0.3");
  });

  test("exits 1 when any row failed", async () => {
    syncAddonsMock.mockImplementation(async () => [okRow(), errorRow()]);
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
    syncAddonsMock.mockImplementation(async () => [
      {
        entry: { id: "gh:a/b", kind: "gh", ref: "a/b" },
        status: "dev",
        message: "dev link, skipped",
      },
    ]);
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

  test("--json prints the row array", async () => {
    listRowsMock.mockImplementation(async () => [okRow()]);
    await runCli(["list", "--json"]);
    const parsed = JSON.parse(logs[0]);
    expect(parsed[0].entry.id).toBe("cf:6124");
  });

  test("--refresh is forwarded", async () => {
    await runCli(["list", "--refresh"]);
    const call = listRowsMock.mock.calls[0][1] as { refresh: boolean };
    expect(call.refresh).toBe(true);
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
      syncAddonsMock.mockImplementation(async () => [okRow()]);
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
