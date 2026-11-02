import { describe, expect, test } from "bun:test";
import type { Row } from "../types";
import {
  cancelAdd,
  cancelConfirm,
  clearProgress,
  initState,
  moveSelection,
  openAdd,
  openAdoptConfirm,
  openRemoveConfirm,
  removePrompt,
  rowColumns,
  selectedRow,
  setError,
  setNotice,
  setProgress,
  setRows,
  setWorking,
  shortenPath,
  tableRows,
  toggleHelp,
  updateAddInput,
} from "./model";

function row(overrides: Partial<Row> = {}): Row {
  return {
    entry: { id: "gh:owner/repo", kind: "gh", ref: "owner/repo" },
    status: "current",
    ...overrides,
  };
}

describe("moveSelection", () => {
  test("clamps within bounds", () => {
    const state = setRows(initState("era", "/addons"), [row(), row(), row()]);
    expect(moveSelection(state, -5).selected).toBe(0);
    expect(moveSelection(state, 5).selected).toBe(2);
    expect(moveSelection(state, 1).selected).toBe(1);
  });

  test("is a no-op outside list mode", () => {
    const state = openAdd(setRows(initState("era", "/addons"), [row(), row()]));
    expect(moveSelection(state, 1).selected).toBe(0);
  });

  test("is a no-op with no rows", () => {
    const state = initState("era", "/addons");
    expect(moveSelection(state, 1).selected).toBe(0);
  });
});

describe("setRows", () => {
  test("clamps selection when the list shrinks", () => {
    const state = { ...initState("era", "/addons"), selected: 2 };
    const next = setRows(state, [row()]);
    expect(next.selected).toBe(0);
  });
});

// Deterministic stand-in for the real (network-free, but not this module's concern)
// service.parseRef: model.ts only needs a function of this shape, injected here so
// these tests don't depend on service.ts's implementation state.
function fakeParse(input: string): { kind: "gh"; ref: string } {
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) return { kind: "gh", ref: input };
  throw new Error(`unrecognised ref: ${input}`);
}

describe("add flow", () => {
  test("openAdd resets input and is blocked while working", () => {
    const state = setWorking(initState("era", "/addons"), true);
    expect(openAdd(state).mode).toBe("list");
    expect(openAdd(setWorking(state, false)).mode).toBe("add");
  });

  test("updateAddInput detects a github ref", () => {
    const state = openAdd(initState("era", "/addons"));
    const next = updateAddInput(state, "owner/repo", fakeParse);
    expect(next.addDetected).toEqual({ kind: "gh", ref: "owner/repo" });
    expect(next.addError).toBeUndefined();
  });

  test("updateAddInput surfaces parse errors", () => {
    const state = openAdd(initState("era", "/addons"));
    const next = updateAddInput(state, "not a valid ref!!", fakeParse);
    expect(next.addDetected).toBeUndefined();
    expect(next.addError).toBeTruthy();
  });

  test("updateAddInput clears detection for empty input", () => {
    const withValue = updateAddInput(openAdd(initState("era", "/addons")), "owner/repo", fakeParse);
    const cleared = updateAddInput(withValue, "", fakeParse);
    expect(cleared.addDetected).toBeUndefined();
    expect(cleared.addError).toBeUndefined();
  });

  test("cancelAdd returns to list and clears input", () => {
    const state = updateAddInput(openAdd(initState("era", "/addons")), "owner/repo", fakeParse);
    const next = cancelAdd(state);
    expect(next.mode).toBe("list");
    expect(next.addInput).toBe("");
  });
});

describe("confirm flows", () => {
  test("openRemoveConfirm works on any row and says what it will delete", () => {
    const installed = row({
      installed: { version: "1.0", versionKey: "1", folders: ["Foo"], installedAt: "now" },
    });
    const confirmed = openRemoveConfirm(setRows(initState("era", "/addons"), [installed]));
    expect(confirmed.mode).toBe("remove-confirm");
    expect(confirmed.confirmId).toBe("gh:owner/repo");
    expect(removePrompt(installed)).toContain("delete Foo");

    const never = row();
    expect(openRemoveConfirm(setRows(initState("era", "/addons"), [never])).mode).toBe(
      "remove-confirm",
    );
    expect(removePrompt(never)).toBe("stop tracking owner/repo? · y/n");
    expect(removePrompt(row({ status: "dev" }))).toContain("dev folder stays");
  });

  test("openAdoptConfirm requires an unmanaged row", () => {
    const unmanaged = setRows(initState("era", "/addons"), [row({ status: "unmanaged" })]);
    expect(openAdoptConfirm(unmanaged).mode).toBe("adopt-confirm");

    const managed = setRows(initState("era", "/addons"), [row({ status: "current" })]);
    expect(openAdoptConfirm(managed).mode).toBe("list");
  });

  test("cancelConfirm returns to list", () => {
    const withInstall = setRows(initState("era", "/addons"), [
      row({ installed: { version: "1.0", versionKey: "1", folders: ["Foo"], installedAt: "now" } }),
    ]);
    const confirmed = openRemoveConfirm(withInstall);
    expect(cancelConfirm(confirmed).mode).toBe("list");
  });
});

describe("progress", () => {
  test("setProgress and clearProgress track per-row phase", () => {
    let state = initState("era", "/addons");
    state = setProgress(state, { id: "gh:owner/repo", phase: "downloading" });
    expect(state.progress["gh:owner/repo"].phase).toBe("downloading");
    state = clearProgress(state, "gh:owner/repo");
    expect(state.progress["gh:owner/repo"]).toBeUndefined();
  });
});

describe("messages", () => {
  test("setError clears notice and vice versa", () => {
    let state = initState("era", "/addons");
    state = setNotice(state, "done");
    expect(state.notice).toBe("done");
    state = setError(state, "boom");
    expect(state.error).toBe("boom");
    expect(state.notice).toBeUndefined();
  });

  test("toggleHelp flips between list and help", () => {
    const state = initState("era", "/addons");
    const help = toggleHelp(state);
    expect(help.mode).toBe("help");
    expect(toggleHelp(help).mode).toBe("list");
  });
});

describe("rowColumns", () => {
  test("shows installed/latest and status", () => {
    const r = row({
      installed: { version: "1.0", versionKey: "1", folders: ["Foo"], installedAt: "now" },
      latest: { version: "1.1", versionKey: "2", url: "https://example.com", archive: "package" },
      status: "update",
    });
    const columns = rowColumns(r);
    expect(columns.installed).toBe("1.0");
    expect(columns.latest).toBe("→ 1.1");
    expect(columns.status).toBe("update available");
  });

  test("prefers live progress over status", () => {
    const r = row();
    const columns = rowColumns(r, { id: r.entry.id, phase: "downloading", message: "42%" });
    expect(columns.status).toBe("downloading: 42%");
  });

  test("falls back to ref when no note", () => {
    const columns = rowColumns(row());
    expect(columns.name).toBe("owner/repo");
  });
});

describe("shortenPath", () => {
  test("replaces the home prefix with ~", () => {
    expect(shortenPath("/home/cjber/addons", "/home/cjber")).toBe("~/addons");
  });

  test("leaves unrelated paths untouched", () => {
    expect(shortenPath("/mnt/addons", "/home/cjber")).toBe("/mnt/addons");
  });
});

describe("selectedRow", () => {
  test("returns the row at the selected index", () => {
    const state = setRows(initState("era", "/addons"), [
      row({ entry: { id: "a", kind: "gh", ref: "a/a" } }),
      row(),
    ]);
    expect(selectedRow(state)?.entry.id).toBe("a");
  });
});

describe("tableRows", () => {
  test("pads columns so rows line up and cuts long names", () => {
    const lines = tableRows(
      [
        { name: "Auctionator", source: "cf", installed: "339", latest: "", status: "up to date" },
        {
          name: "A".repeat(40),
          source: "gh",
          installed: "v1",
          latest: "→ v2",
          status: "update available",
        },
      ],
      ["name", "source", "installed", "latest", "status"],
    ).map((cells) => cells.join("  "));
    expect(lines[0].indexOf("cf")).toBe(lines[1].indexOf("gh"));
    expect(lines[1]).toContain(`${"A".repeat(27)}…`);
  });
});

for (const phase of ["done", "skipped", "failed"] as const) {
  test(`terminal phase ${phase} clears progress and shows the real row status`, () => {
    const addon = row({ status: "update" });
    let state = initState("era", "/addons", [addon]);
    state = setProgress(state, { id: addon.entry.id, phase: "downloading" });
    state = setProgress(state, { id: addon.entry.id, phase, message: "old result" });
    expect(state.progress[addon.entry.id]).toBeUndefined();
    expect(rowColumns(addon, state.progress[addon.entry.id]).status).toBe("update available");
  });
}
