import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setFetch } from "./http";
import {
  DEV_SKIPPED,
  installAddon,
  pendingPath,
  protectedFolder,
  removeInstalled,
  withInstallLock,
} from "./install";
import { LOCK_MAX_AGE_MS } from "./lock";
import { readState, type State, writeState } from "./state";
import { offline, tempContext, zip } from "./testing/helpers";
import type { Entry, Installed, Release } from "./types";

let fixture: Awaited<ReturnType<typeof tempContext>>;
let state: State;
const entry: Entry = { id: "gh:a/b", kind: "gh", ref: "a/b" };
const release: Release = {
  version: "v2",
  versionKey: "2",
  url: "https://github.com/a/b/file.zip",
  archive: "package",
};
const installed = (folders = ["Foo"], versionKey = "1"): Installed => ({
  version: "v1",
  versionKey,
  folders,
  installedAt: "before",
});
beforeEach(async () => {
  offline();
  fixture = await tempContext();
  state = await readState(fixture.ctx);
});
afterEach(async () => {
  offline();
  await fixture.cleanup();
});
async function folder(name: string, contents = "old") {
  const path = join(fixture.ctx.addonsDir, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "marker"), contents);
  return path;
}
async function own(folders = ["Foo"]) {
  state.addons[entry.id] = installed(folders);
  await writeState(fixture.ctx, state);
}
async function download(folders = ["Foo"]) {
  const files: Record<string, string> = {};
  for (const name of folders) {
    files[`${name}/${name}.toc`] = "## Interface: 16001";
    files[`${name}/marker`] = "new";
  }
  const bytes = await zip(files);
  let calls = 0;
  setFetch(async (url) => {
    expect(url).toBe(release.url);
    calls++;
    return new Response(bytes);
  });
  return () => calls;
}
async function devLink(name: string, version?: string) {
  const development = join(fixture.root, `dev-${name}`);
  await mkdir(development, { recursive: true });
  await writeFile(join(development, "marker"), "dev");
  await writeFile(
    join(development, `${name}.toc`),
    `## Interface: 16001${version ? `\n## Version: ${version}` : ""}\n`,
  );
  await symlink(development, join(fixture.ctx.addonsDir, name));
  return development;
}
async function contents(name: string) {
  return readFile(join(fixture.ctx.addonsDir, name, "marker"), "utf8");
}
test("installs multiple folders and leaves no pending transaction", async () => {
  await download(["Foo", "Bar"]);
  const row = await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, release),
  );
  expect(row.status).toBe("current");
  expect(row.installed?.folders).toEqual(["Bar", "Foo"]);
  expect(await contents("Foo")).toBe("new");
  expect(await contents("Bar")).toBe("new");
  expect(await readdir(dirname(fixture.ctx.addonsDir))).toEqual(["AddOns"]);
  expect((await readState(fixture.ctx)).addons[entry.id].versionKey).toBe("2");
});
for (const kind of ["symlink", "broken", "git-dir", "git-file"] as const)
  test(`known ${kind} is skipped untouched before download`, async () => {
    const target = join(fixture.ctx.addonsDir, "Foo");
    if (kind === "symlink" || kind === "broken") {
      const development = join(fixture.root, "dev");
      if (kind === "symlink") {
        await mkdir(development);
        await writeFile(join(development, "marker"), "dev");
      }
      await symlink(development, target);
    } else {
      await folder("Foo");
      if (kind === "git-dir") await mkdir(join(target, ".git"));
      else await writeFile(join(target, ".git"), "gitdir: /elsewhere");
    }
    await own();
    const row = await withInstallLock(fixture.ctx, (current) =>
      installAddon(fixture.ctx, current, entry, release),
    );
    expect(row.status).toBe("dev");
    expect(row.message).toBe(DEV_SKIPPED);
    expect((await readState(fixture.ctx)).addons[entry.id].versionKey).toBe("1");
    if (kind === "symlink" || kind === "broken")
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
    else expect(await contents("Foo")).toBe("old");
  });
test("an expired dev build is replaced through its symlink and leaves its target intact", async () => {
  const development = await devLink("Foo", "v1.0.0-dev+3fa2c1d");
  await own();
  const calls = await download();
  const row = await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, { ...release, version: "v1.1.0" }),
  );
  expect(row).toMatchObject({
    status: "updated",
    devTag: "v1.0.0",
    installed: { version: "v1.1.0", versionKey: "2" },
  });
  expect(row.message).toContain("dev build of v1.0.0");
  expect(calls()).toBe(1);
  expect((await lstat(join(fixture.ctx.addonsDir, "Foo"))).isSymbolicLink()).toBe(false);
  expect(await contents("Foo")).toBe("new");
  expect(await readFile(join(development, "marker"), "utf8")).toBe("dev");
  expect(await readFile(join(development, "Foo.toc"), "utf8")).toContain("v1.0.0-dev+3fa2c1d");
});
test("an unexpired dev build stays a dev link with its tag", async () => {
  const development = await devLink("Foo", "v1.1.0-dev+3fa2c1d");
  await own();
  const calls = await download();
  const row = await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, { ...release, version: "v1.1.0" }),
  );
  expect(row).toMatchObject({ status: "dev", devTag: "v1.1.0" });
  expect(row.message).toBe("dev build of v1.1.0, waiting for a newer release");
  expect(calls()).toBe(0);
  expect((await lstat(join(fixture.ctx.addonsDir, "Foo"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(development, "marker"), "utf8")).toBe("dev");
});
test("a plain symlink is still skipped untouched", async () => {
  const development = await devLink("Foo");
  await own();
  const calls = await download();
  const row = await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, { ...release, version: "v1.1.0" }),
  );
  expect(row.status).toBe("dev");
  expect(row.message).toBe(DEV_SKIPPED);
  expect(row.devTag).toBeUndefined();
  expect(calls()).toBe(0);
  expect((await lstat(join(fixture.ctx.addonsDir, "Foo"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(development, "marker"), "utf8")).toBe("dev");
});
test("a git checkout with a dev version is still never touched", async () => {
  const path = await folder("Foo");
  await mkdir(join(path, ".git"));
  await writeFile(join(path, "Foo.toc"), "## Interface: 16001\n## Version: v1.0.0-dev+3fa2c1d\n");
  await own();
  const calls = await download();
  const row = await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, { ...release, version: "v1.1.0" }),
  );
  expect(row.status).toBe("dev");
  expect(row.message).toBe(DEV_SKIPPED);
  expect(calls()).toBe(0);
  expect(await contents("Foo")).toBe("old");
  expect((await readdir(path)).sort()).toEqual([".git", "Foo.toc", "marker"]);
});
test("unknown protected folder skips whole multi-folder addon after validation", async () => {
  const path = await folder("Foo");
  await mkdir(join(path, ".git"));
  await download(["Foo", "Bar"]);
  const row = await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, release),
  );
  expect(row.status).toBe("dev");
  expect(await contents("Foo")).toBe("old");
  expect(await readdir(fixture.ctx.addonsDir)).toEqual(["Foo"]);
});
test("inside a git worktree skips without touching it", async () => {
  await folder("Foo");
  await own();
  await mkdir(join(dirname(fixture.ctx.addonsDir), ".git"));
  expect(
    (
      await withInstallLock(fixture.ctx, (current) =>
        installAddon(fixture.ctx, current, entry, release),
      )
    ).status,
  ).toBe("dev");
  expect(await contents("Foo")).toBe("old");
});
test("unowned collision requires adopt; adopt replaces and owns", async () => {
  await folder("Foo");
  await download();
  await expect(
    withInstallLock(fixture.ctx, (current) => installAddon(fixture.ctx, current, entry, release)),
  ).rejects.toMatchObject({ code: "UNMANAGED" });
  expect(await contents("Foo")).toBe("old");
  await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, release, { adopt: true }),
  );
  expect(await contents("Foo")).toBe("new");
  expect((await readState(fixture.ctx)).addons[entry.id].folders).toEqual(["Foo"]);
});
test("ownership conflict cannot be overridden with adopt", async () => {
  await folder("Foo");
  state.addons["cf:123"] = installed();
  await writeState(fixture.ctx, state);
  await download();
  await expect(
    withInstallLock(fixture.ctx, (current) =>
      installAddon(fixture.ctx, current, entry, release, { adopt: true }),
    ),
  ).rejects.toMatchObject({ code: "OWNED_BY_OTHER" });
  expect(await contents("Foo")).toBe("old");
});
test("rollback reverses completed renames after injected mid-swap failure", async () => {
  await folder("Foo");
  await folder("Bar");
  await own(["Foo", "Bar"]);
  await download(["Foo", "Bar"]);
  let calls = 0;
  await expect(
    withInstallLock(fixture.ctx, (current) =>
      installAddon(fixture.ctx, current, entry, release, {
        rename: async (from, to) => {
          calls++;
          if (calls === 4) throw new Error("injected rename failure");
          await rename(from, to);
        },
      }),
    ),
  ).rejects.toThrow("injected rename failure");
  expect(await contents("Foo")).toBe("old");
  expect(await contents("Bar")).toBe("old");
  expect(await readState(fixture.ctx)).toEqual(state);
  expect(await readdir(dirname(fixture.ctx.addonsDir))).toEqual(["AddOns"]);
});
test("EXDEV fails clearly and restores folders", async () => {
  await folder("Foo");
  await own();
  await download();
  await expect(
    withInstallLock(fixture.ctx, (current) =>
      installAddon(fixture.ctx, current, entry, release, {
        rename: async () => {
          throw Object.assign(new Error("cross device"), { code: "EXDEV" });
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "INSTALL_FILESYSTEM" });
  expect(await contents("Foo")).toBe("old");
});
for (const committed of [false, true])
  test(`pending recovery restores previous folders and state (state committed: ${committed})`, async () => {
    await folder("Foo");
    await own();
    const txDir = join(dirname(fixture.ctx.addonsDir), ".wowaddon-aaaa");
    await mkdir(join(txDir, "new"), { recursive: true });
    await mkdir(join(txDir, "old"));
    await rename(join(fixture.ctx.addonsDir, "Foo"), join(txDir, "old/Foo"));
    await folder("Foo", "new");
    await folder("New", "new");
    await writeFile(
      pendingPath(fixture.ctx),
      JSON.stringify({
        schema: 1,
        addonsDir: fixture.ctx.addonsDir,
        txDir,
        before: state,
        operations: [
          { folder: "Foo", hadOld: true, putNew: true },
          { folder: "New", hadOld: false, putNew: true },
        ],
      }),
    );
    if (committed) {
      const next = structuredClone(state);
      next.addons[entry.id] = installed(["Foo", "New"], "2");
      await writeState(fixture.ctx, next);
    }
    await withInstallLock(fixture.ctx, async (current) => {
      expect(current).toEqual(state);
    });
    expect(await contents("Foo")).toBe("old");
    expect(await readdir(fixture.ctx.addonsDir)).toEqual(["Foo"]);
    expect(fixture.ctx.notices).toContain(
      "Recovered an interrupted addon installation from its backups.",
    );
  });
test("unchanged version skips download, but missing folder reinstalls", async () => {
  await folder("Foo");
  await own();
  state.addons[entry.id].versionKey = "2";
  await writeState(fixture.ctx, state);
  expect(
    (
      await withInstallLock(fixture.ctx, (current) =>
        installAddon(fixture.ctx, current, entry, release),
      )
    ).message,
  ).toBe("up to date");
  await rm(join(fixture.ctx.addonsDir, "Foo"), { recursive: true });
  const calls = await download();
  await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, release),
  );
  expect(calls()).toBe(1);
});
test("obsolete owned folders removed and unrelated folder preserved", async () => {
  await folder("Foo");
  await folder("OldModule");
  await folder("Unrelated");
  await own(["Foo", "OldModule"]);
  await download();
  await withInstallLock(fixture.ctx, (current) =>
    installAddon(fixture.ctx, current, entry, release),
  );
  expect((await readdir(fixture.ctx.addonsDir)).sort()).toEqual(["Foo", "Unrelated"]);
  expect(await contents("Unrelated")).toBe("old");
});
test("remove deletes only owned folders", async () => {
  await folder("Foo");
  await folder("Unrelated");
  await own();
  await withInstallLock(fixture.ctx, (current) => removeInstalled(fixture.ctx, current, entry.id));
  expect(await readdir(fixture.ctx.addonsDir)).toEqual(["Unrelated"]);
  expect((await readState(fixture.ctx)).addons).toEqual({});
});
test("remove stops tracking a dev folder and leaves the folder untouched", async () => {
  const path = await folder("Foo");
  await writeFile(join(path, ".git"), "gitdir: /dev");
  await own();
  await withInstallLock(fixture.ctx, (current) => removeInstalled(fixture.ctx, current, entry.id));
  expect((await readState(fixture.ctx)).addons).toEqual({});
  expect((await readdir(path)).sort()).toEqual([".git", "marker"]);
  expect(await contents("Foo")).toBe("old");
  expect(await readFile(join(path, ".git"), "utf8")).toBe("gitdir: /dev");
  expect(await readdir(dirname(fixture.ctx.addonsDir))).toEqual(["AddOns"]);
});
test("live lock blocks, dead PID lock is recovered", async () => {
  const lock = join(fixture.ctx.configDir, "state/forever.lock");
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  await expect(withInstallLock(fixture.ctx, async () => {})).rejects.toMatchObject({
    code: "LOCKED",
  });
  await writeFile(lock, JSON.stringify({ pid: 2147483647 }));
  await withInstallLock(fixture.ctx, async () => {});
  expect(await readdir(dirname(lock))).not.toContain("forever.lock");
});
test("a lock held by another user's live process (EPERM) blocks", async () => {
  const lock = join(fixture.ctx.configDir, "state/forever.lock");
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: 4242, startedAt: Date.now() }));
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });
  try {
    await expect(withInstallLock(fixture.ctx, async () => {})).rejects.toMatchObject({
      code: "LOCKED",
    });
  } finally {
    kill.mockRestore();
  }
  expect(await readFile(lock, "utf8")).toContain("4242");
});
test("a lock older than the maximum age is reclaimed even if its PID was reused", async () => {
  const lock = join(fixture.ctx.configDir, "state/forever.lock");
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(
    lock,
    JSON.stringify({ pid: process.pid, startedAt: Date.now() - LOCK_MAX_AGE_MS - 1000 }),
  );
  await withInstallLock(fixture.ctx, async () => {});
  expect(await readdir(dirname(lock))).not.toContain("forever.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  await expect(withInstallLock(fixture.ctx, async () => {})).rejects.toMatchObject({
    code: "LOCKED",
  });
});
test("reclaiming a stale lock is always followed by another attempt", async () => {
  const lock = join(fixture.ctx.configDir, "state/forever.lock");
  await mkdir(dirname(lock), { recursive: true });
  const realOpen = fs.open;
  let stale = 0;
  // Three dead runs leave a lock just before each of the first three attempts.
  const probe = spyOn(fs, "open").mockImplementation((async (path, ...rest) => {
    if (path === lock && stale < 3)
      await writeFile(lock, JSON.stringify({ pid: 2147483647, run: ++stale }));
    return realOpen(path, ...rest);
  }) as typeof fs.open);
  try {
    expect(await withInstallLock(fixture.ctx, async () => "ran")).toBe("ran");
  } finally {
    probe.mockRestore();
  }
  expect(stale).toBe(3);
  expect(await readdir(dirname(lock))).not.toContain("forever.lock");
});
test("corrupt pending record blocks mutations and never deletes outside staging", async () => {
  await mkdir(dirname(pendingPath(fixture.ctx)), { recursive: true });
  await writeFile(
    pendingPath(fixture.ctx),
    JSON.stringify({
      schema: 1,
      addonsDir: fixture.ctx.addonsDir,
      txDir: fixture.root,
      before: state,
      operations: [],
    }),
  );
  await expect(withInstallLock(fixture.ctx, async () => {})).rejects.toMatchObject({
    code: "PENDING_CORRUPT",
  });
  expect((await lstat(fixture.root)).isDirectory()).toBe(true);
});

test("cancellation after the first folder swap rolls back every change", async () => {
  await folder("Foo");
  await folder("Bar");
  await own(["Foo", "Bar"]);
  await download(["Foo", "Bar"]);
  const controller = new AbortController();
  let calls = 0;
  await expect(
    withInstallLock(fixture.ctx, (current) =>
      installAddon(fixture.ctx, current, entry, release, {
        signal: controller.signal,
        rename: async (from, to) => {
          await rename(from, to);
          if (++calls === 2) controller.abort();
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "ABORTED" });
  expect(await contents("Foo")).toBe("old");
  expect(await contents("Bar")).toBe("old");
  expect(await readState(fixture.ctx)).toEqual(state);
});
test("a folder protected mid-install rolls back the swapped ones and is left untouched", async () => {
  await folder("Foo");
  const bar = await folder("Bar");
  await own(["Foo", "Bar"]);
  await download(["Foo", "Bar"]);
  let calls = 0;
  await expect(
    withInstallLock(fixture.ctx, (current) =>
      installAddon(fixture.ctx, current, entry, release, {
        rename: async (from, to) => {
          await rename(from, to);
          // Foo has been swapped in; Bar becomes a checkout before its turn.
          if (++calls === 2) await mkdir(join(bar, ".git"));
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "DEV_PROTECTED" });
  expect(calls).toBe(2);
  expect(await contents("Foo")).toBe("old");
  expect(await contents("Bar")).toBe("old");
  expect((await readdir(bar)).sort()).toEqual([".git", "marker"]);
  expect(await readState(fixture.ctx)).toEqual(state);
  expect(await readdir(dirname(fixture.ctx.addonsDir))).toEqual(["AddOns"]);
  expect(await readdir(dirname(pendingPath(fixture.ctx)))).not.toContain("forever.pending.json");
});
test("protection is rechecked after download before swap", async () => {
  const path = await folder("Foo");
  await own();
  const bytes = await zip({ "Foo/Foo.toc": "## Interface: 16001" });
  setFetch(async () => {
    await mkdir(join(path, ".git"));
    return new Response(bytes);
  });
  expect(
    (
      await withInstallLock(fixture.ctx, (current) =>
        installAddon(fixture.ctx, current, entry, release),
      )
    ).status,
  ).toBe("dev");
  expect(await contents("Foo")).toBe("old");
});
test("corrupt state blocks before any network call", async () => {
  await mkdir(join(fixture.ctx.configDir, "state"));
  await writeFile(join(fixture.ctx.configDir, "state/forever.json"), "broken");
  await expect(
    withInstallLock(fixture.ctx, (current) => installAddon(fixture.ctx, current, entry, release)),
  ).rejects.toMatchObject({ code: "STATE_CORRUPT" });
});

test("nested git repositories are protected", async () => {
  const path = await folder("Foo");
  await mkdir(join(path, "nested/.git"), { recursive: true });
  await own();
  expect(
    (
      await withInstallLock(fixture.ctx, (current) =>
        installAddon(fixture.ctx, current, entry, release),
      )
    ).status,
  ).toBe("dev");
  expect(await contents("Foo")).toBe("old");
});
test("failed rollback preserves the pending record and blocks further transactions", async () => {
  await folder("Foo");
  await own();
  await download();
  await withInstallLock(fixture.ctx, async (current) => {
    let calls = 0;
    await expect(
      installAddon(fixture.ctx, current, entry, release, {
        rename: async (from, to) => {
          if (++calls === 2) {
            await symlink(join(fixture.root, "developer"), join(fixture.ctx.addonsDir, "Foo"));
            throw new Error("target changed");
          }
          await rename(from, to);
        },
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
    const pending = await readFile(pendingPath(fixture.ctx), "utf8");
    await expect(removeInstalled(fixture.ctx, current, entry.id)).rejects.toMatchObject({
      code: "RECOVERY_BLOCKED",
    });
    expect(await readFile(pendingPath(fixture.ctx), "utf8")).toBe(pending);
  });
  const pending = JSON.parse(await readFile(pendingPath(fixture.ctx), "utf8"));
  expect(await readFile(join(pending.txDir, "old/Foo/marker"), "utf8")).toBe("old");
  await rm(join(fixture.ctx.addonsDir, "Foo"));
  await withInstallLock(fixture.ctx, async () => {});
  expect(await contents("Foo")).toBe("old");
});

test("a dev link carrying the addon's CurseForge ID is skipped before the first install", async () => {
  const development = join(dirname(fixture.ctx.addonsDir), "dev-legacy");
  await mkdir(development, { recursive: true });
  await writeFile(
    join(development, "Legacy.toc"),
    "## Interface: 16001\n## X-Curse-Project-ID: 1705879\n",
  );
  await symlink(development, join(fixture.ctx.addonsDir, "Legacy"));
  const calls = await download(["Other"]);
  const legacy: Entry = { id: "cf:1705879", kind: "cf", ref: "1705879" };
  expect((await installAddon(fixture.ctx, state, legacy, release)).status).toBe("dev");
  expect(calls()).toBe(0);
  expect((await lstat(join(fixture.ctx.addonsDir, "Legacy"))).isSymbolicLink()).toBe(true);
});

test("ancestor git checks are shared across folders and renewed for the next operation", async () => {
  const probe = spyOn(fs, "lstat");
  const ancestor = join(fixture.ctx.addonsDir, ".git");
  try {
    await withInstallLock(fixture.ctx, async () => {
      for (const name of ["Foo", "Bar", "Baz"])
        expect(await protectedFolder(fixture.ctx, name)).toBe(false);
    });
    expect(probe.mock.calls.filter(([path]) => path === ancestor)).toHaveLength(1);
    await mkdir(join(dirname(fixture.ctx.addonsDir), ".git"));
    await withInstallLock(fixture.ctx, async () => {
      expect(await protectedFolder(fixture.ctx, "Foo")).toBe(true);
    });
    expect(probe.mock.calls.filter(([path]) => path === ancestor)).toHaveLength(2);
  } finally {
    probe.mockRestore();
  }
});
