import { constants } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { flavors } from "./flavors";
import { type Context, type Flavor, WowaddonError } from "./types";

const environments = new WeakMap<Context, NodeJS.ProcessEnv>();
export const contextEnv = (ctx: Context): NodeJS.ProcessEnv => environments.get(ctx) ?? process.env;
export const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
export function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
async function directory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
export async function discoverAddons(home: string, flavor: Flavor): Promise<string[]> {
  const tail = `drive_c/Program Files*/World of Warcraft/${flavors[flavor].clientDir}/Interface/AddOns`;
  const patterns = [
    `Games/*/${tail}`,
    `.local/share/Steam/steamapps/compatdata/*/pfx/${tail}`,
    `.steam/steam/steamapps/compatdata/*/pfx/${tail}`,
    `.steam/root/steamapps/compatdata/*/pfx/${tail}`,
  ];
  const matches = new Set<string>();
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: home,
      absolute: true,
      onlyFiles: false,
      followSymlinks: true,
    })) {
      if (await directory(path)) matches.add(await realpath(path));
    }
  }
  return [...matches].sort();
}
interface Config {
  defaultFlavor?: Flavor;
  addonsDir?: Partial<Record<Flavor, string>>;
}
async function readConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  try {
    const data = JSON.parse(text);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      (data.defaultFlavor !== undefined && !["era", "forever"].includes(data.defaultFlavor))
    )
      throw new Error();
    if (
      data.addonsDir !== undefined &&
      (!data.addonsDir ||
        typeof data.addonsDir !== "object" ||
        Array.isArray(data.addonsDir) ||
        Object.values(data.addonsDir).some((v) => typeof v !== "string" || !v.trim()))
    )
      throw new Error();
    return data;
  } catch {
    throw new WowaddonError("CONFIG_INVALID", `Invalid configuration: ${path}`);
  }
}
export async function openContext(opts: {
  flavor?: Flavor;
  addonsDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Context> {
  const env = opts.env ?? process.env;
  const home = env.HOME || homedir();
  const configDir = resolve(
    expandHome(env.XDG_CONFIG_HOME || join(home, ".config"), home),
    "wowaddon",
  );
  const config = await readConfig(join(configDir, "config.json"));
  const flavor = opts.flavor ?? config.defaultFlavor ?? "era";
  if (!(flavor in flavors)) throw new WowaddonError("CONFIG_INVALID", `Unknown flavor: ${flavor}`);
  let addonsDir =
    opts.addonsDir || (flavor === "era" ? env.WOW_ADDONS : undefined) || config.addonsDir?.[flavor];
  if (!addonsDir) {
    const fallback =
      flavor === "era"
        ? join(
            home,
            ".local/share/Steam/steamapps/compatdata/3391668301/pfx/drive_c/Program Files (x86)/World of Warcraft/_classic_era_/Interface/AddOns",
          )
        : join(
            home,
            "Games/battlenet/drive_c/Program Files (x86)/World of Warcraft/_classic_beta_/Interface/AddOns",
          );
    if (await directory(fallback)) addonsDir = fallback;
    else {
      const found = await discoverAddons(home, flavor);
      if (found.length > 1)
        throw new WowaddonError(
          "CONFIG_AMBIGUOUS",
          `Multiple AddOns directories found; choose --addons-dir:\n${found.join("\n")}`,
        );
      addonsDir = found[0];
    }
  }
  if (!addonsDir)
    throw new WowaddonError(
      "CONFIG_MISSING",
      `No ${flavors[flavor].name} AddOns directory found. Set --addons-dir${flavor === "era" ? ", WOW_ADDONS," : ""} or config.json.`,
    );
  addonsDir = resolve(expandHome(addonsDir, home));
  if (!(await directory(addonsDir)))
    throw new WowaddonError("CONFIG_MISSING", `AddOns directory does not exist: ${addonsDir}`);
  addonsDir = await realpath(addonsDir);
  await mkdir(configDir, { recursive: true });
  const notices: string[] = [];
  try {
    await copyFile(
      join(configDir, "addons.txt"),
      join(configDir, "era.txt"),
      constants.COPYFILE_EXCL,
    );
    notices.push("Copied legacy addons.txt to era.txt; addons.txt was left untouched.");
  } catch (error) {
    if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const ctx: Context = { flavor, addonsDir, configDir, notices };
  environments.set(ctx, env);
  return ctx;
}
