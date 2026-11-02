import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { contextEnv, isMissing } from "./config";
import { HUB } from "./discover/github";
import { flavors } from "./flavors";
import { requestJson } from "./http";
import { type Context, type SourceKind, WowaddonError } from "./types";

// WowUp (and WowUp-CF) keep the addons they installed in addons.json and the game installs in
// preferences.json, both electron-store files in the app's data folder. Read only, never written.
export interface WowupAddon {
  name: string;
  provider: string;
  externalId: string;
  folders: string[];
  version?: string;
}
export interface WowupData {
  path: string;
  installation: string;
  addons: WowupAddon[];
}
interface Installation {
  id: string;
  label?: string;
  displayName?: string;
  location?: string;
}
interface StoredAddon {
  name?: string;
  providerName?: string;
  externalId?: string | number;
  installationId?: string;
  installedFolders?: string;
  installedFolderList?: string[];
  installedVersion?: string;
}

const appNames = ["WowUp", "WowUpCf", "WowUp-CF"];
async function children(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).map((name) => join(path, name));
  } catch {
    return [];
  }
}
// Native Linux and macOS data folders, then the Roaming folder of every Wine prefix under ~/Games
// and ~/.wine, where a Windows WowUp keeps its data.
export async function wowupCandidates(ctx: Context): Promise<string[]> {
  const env = contextEnv(ctx);
  const home = env.HOME || homedir();
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const roots = [config, join(home, "Library", "Application Support")];
  if (env.APPDATA) roots.push(env.APPDATA);
  const prefixes = [join(home, ".wine"), ...(await children(join(home, "Games")))];
  for (const prefix of prefixes)
    for (const user of await children(join(prefix, "drive_c", "users")))
      roots.push(join(user, "AppData", "Roaming"));
  return roots.flatMap((root) => appNames.map((name) => join(root, name)));
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new WowaddonError("WOWUP_INVALID", `Couldn't read WowUp data: ${path}`);
  }
}

// The WowUp installation for this flavor: the one whose game folder is the flavor's client
// folder, else the one whose label names the flavor (WowUp calls Forever "World of Warcraft: Forever").
function pickInstallation(ctx: Context, installations: Installation[]): Installation | undefined {
  const { clientDir, name } = flavors[ctx.flavor];
  return (
    installations.find((install) => install.location?.split(/[\\/]/).includes(clientDir)) ??
    installations.find((install) =>
      `${install.label ?? ""} ${install.displayName ?? ""}`
        .toLowerCase()
        .includes(name.toLowerCase()),
    )
  );
}

export async function readWowup(ctx: Context, path?: string): Promise<WowupData | undefined> {
  for (const dir of path ? [path] : await wowupCandidates(ctx)) {
    const stored = await readJson<Record<string, StoredAddon>>(join(dir, "addons.json"));
    if (!stored) {
      if (path) throw new WowaddonError("WOWUP_MISSING", `No WowUp addons.json in ${path}.`);
      continue;
    }
    const preferences = await readJson<{ wow_installations?: Installation[] | string }>(
      join(dir, "preferences.json"),
    );
    let installations = preferences?.wow_installations ?? [];
    if (typeof installations === "string")
      installations = JSON.parse(installations) as Installation[];
    const installation = pickInstallation(ctx, Array.isArray(installations) ? installations : []);
    if (!installation) continue;
    const addons = Object.values(stored)
      .filter((addon) => addon?.installationId === installation.id)
      .flatMap((addon): WowupAddon[] =>
        typeof addon.providerName === "string" && addon.externalId !== undefined
          ? [
              {
                name: addon.name ?? String(addon.externalId),
                provider: addon.providerName,
                externalId: String(addon.externalId),
                folders:
                  addon.installedFolderList ??
                  (addon.installedFolders ?? "")
                    .split(",")
                    .map((f) => f.trim())
                    .filter(Boolean),
                ...(addon.installedVersion ? { version: addon.installedVersion } : {}),
              },
            ]
          : [],
      );
    return {
      path: dir,
      installation: installation.label ?? installation.displayName ?? installation.id,
      addons,
    };
  }
  return undefined;
}

const tukuiIds: Record<string, string> = { "-1": "tukui", "-2": "elvui" };
// The wowaddon ref for one WowUp record, or why there is none.
export async function wowupRef(
  addon: WowupAddon,
  signal?: AbortSignal,
): Promise<{ kind: SourceKind; ref: string } | { reason: string }> {
  const id = addon.externalId;
  switch (addon.provider.toLowerCase()) {
    case "curse":
    case "curseforge":
      return { kind: "cf", ref: id };
    case "github":
      return { kind: "gh", ref: id.toLowerCase() };
    case "wowinterface":
      return { kind: "wowi", ref: id };
    case "tukui":
      return tukuiIds[id] || /^[a-z]/i.test(id)
        ? { kind: "tukui", ref: (tukuiIds[id] ?? id).toLowerCase() }
        : { reason: `unknown Tukui id ${id}` };
    case "wago":
      return { kind: "wago", ref: id };
    case "wowuphub": {
      const found = await requestJson<{ addon?: { repository?: string } }>(
        `${HUB}/addons/${encodeURIComponent(id)}`,
        { signal },
      ).catch(() => undefined);
      const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/i.exec(
        found?.addon?.repository ?? "",
      )?.[1];
      return repo
        ? { kind: "gh", ref: repo.toLowerCase() }
        : { reason: "WowUp Hub has no repository for it" };
    }
    default:
      return { reason: `WowUp provider ${addon.provider} has no wowaddon source` };
  }
}
