import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAddons, openContext } from "./config";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "wowaddon-config-"));
  roots.push(root);
  const config = join(root, ".config/wowaddon");
  await mkdir(config, { recursive: true });
  return { root, config, env: { HOME: root } };
}
async function dir(path: string) {
  await mkdir(path, { recursive: true });
  return path;
}
test("CLI > environment > config and selected default flavor", async () => {
  const { root, config, env } = await home();
  const cli = await dir(join(root, "cli"));
  const environment = await dir(join(root, "env"));
  const configured = await dir(join(root, "configured"));
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({ defaultFlavor: "forever", addonsDir: { forever: configured } }),
  );
  expect(
    (await openContext({ addonsDir: cli, env: { ...env, WOW_ADDONS: environment } })).addonsDir,
  ).toBe(cli);
  expect((await openContext({ env: { ...env, WOW_ADDONS: environment } })).addonsDir).toBe(
    environment,
  );
  expect(await openContext({ env })).toMatchObject({ addonsDir: configured, flavor: "forever" });
});
test("legacy manifest copied exactly once and left untouched", async () => {
  const { root, config, env } = await home();
  const addonsDir = await dir(join(root, "addons"));
  await writeFile(join(config, "addons.txt"), "gh A/B  # old\n");
  expect((await openContext({ addonsDir, env })).notices).toHaveLength(1);
  expect(await readFile(join(config, "era.txt"), "utf8")).toBe("gh A/B  # old\n");
  await writeFile(join(config, "era.txt"), "gh C/D\n");
  expect((await openContext({ addonsDir, env })).notices).toHaveLength(0);
  expect(await readFile(join(config, "addons.txt"), "utf8")).toBe("gh A/B  # old\n");
  expect(await readFile(join(config, "era.txt"), "utf8")).toBe("gh C/D\n");
});
test("default exists before discovery; honors XDG and tilde", async () => {
  const { root, env } = await home();
  const fallback = await dir(
    join(
      root,
      "Games/battlenet/drive_c/Program Files (x86)/World of Warcraft/_classic_beta_/Interface/AddOns",
    ),
  );
  await dir(
    join(
      root,
      "Games/another/drive_c/Program Files/World of Warcraft/_classic_beta_/Interface/AddOns",
    ),
  );
  expect((await openContext({ flavor: "forever", env })).addonsDir).toBe(fallback);
  const ctx = await openContext({
    addonsDir: "~/Games",
    env: { ...env, XDG_CONFIG_HOME: "~/settings" },
  });
  expect(ctx.configDir).toBe(join(root, "settings/wowaddon"));
});
test("Games and Steam discovery, ambiguous and no hit errors", async () => {
  const { root, env } = await home();
  await expect(openContext({ flavor: "forever", env })).rejects.toMatchObject({
    code: "CONFIG_MISSING",
  });
  const games = await dir(
    join(root, "Games/wow/drive_c/Program Files/World of Warcraft/_classic_beta_/Interface/AddOns"),
  );
  expect((await openContext({ flavor: "forever", env })).addonsDir).toBe(games);
  const steam = await dir(
    join(
      root,
      ".local/share/Steam/steamapps/compatdata/123/pfx/drive_c/Program Files (x86)/World of Warcraft/_classic_beta_/Interface/AddOns",
    ),
  );
  expect(await discoverAddons(root, "forever")).toEqual([steam, games].sort());
  await expect(openContext({ flavor: "forever", env })).rejects.toMatchObject({
    code: "CONFIG_AMBIGUOUS",
  });
});
test("invalid config blocks and explicit missing path does not fall back", async () => {
  const { root, config, env } = await home();
  await writeFile(join(config, "config.json"), '{"defaultFlavor":"retail"}');
  await expect(openContext({ addonsDir: root, env })).rejects.toMatchObject({
    code: "CONFIG_INVALID",
  });
  await rm(join(config, "config.json"));
  await expect(openContext({ addonsDir: join(root, "missing"), env })).rejects.toMatchObject({
    code: "CONFIG_MISSING",
  });
});
