import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isMissing } from "./config";
import { type Context, type Installed, WowaddonError } from "./types";

export interface State {
  schema: 1;
  addonsDir: string;
  addons: Record<string, Installed>;
}
export const statePath = (ctx: Context): string =>
  join(ctx.configDir, "state", `${ctx.flavor}.json`);
export function safeFolder(name: unknown): name is string {
  return (
    typeof name === "string" &&
    !!name &&
    !/[\\/:\p{Cc}]/u.test(name) &&
    name !== "." &&
    name !== ".." &&
    name.toLowerCase() !== ".git" &&
    !/[. ]$/.test(name)
  );
}
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
export function validateState(data: unknown, ctx: Context): State {
  const invalid = (): never => {
    throw new WowaddonError(
      "STATE_CORRUPT",
      `State is corrupt or has an unsupported schema: ${statePath(ctx)}. Restore it before making changes.`,
    );
  };
  if (!data || typeof data !== "object") return invalid();
  const state = data as State;
  if (
    state.schema !== 1 ||
    typeof state.addonsDir !== "string" ||
    !state.addons ||
    typeof state.addons !== "object" ||
    Array.isArray(state.addons)
  )
    return invalid();
  if (resolve(state.addonsDir) !== resolve(ctx.addonsDir))
    throw new WowaddonError(
      "STATE_DESTINATION",
      `State belongs to ${state.addonsDir}, not ${ctx.addonsDir}. Use the original AddOns directory or a separate configuration directory.`,
    );
  const folders = new Set<string>();
  for (const [id, installed] of Object.entries(state.addons)) {
    if (
      !/^(?:gh:[a-z0-9-]+\/[a-z0-9_.-]+|cf:[1-9]\d*|wowi:[1-9]\d*)$/.test(id) ||
      !installed ||
      typeof installed.version !== "string" ||
      typeof installed.versionKey !== "string" ||
      typeof installed.installedAt !== "string" ||
      !Array.isArray(installed.folders) ||
      installed.folders.length === 0
    )
      return invalid();
    for (const folder of installed.folders) {
      if (!safeFolder(folder) || folders.has(folder.toLowerCase())) return invalid();
      folders.add(folder.toLowerCase());
    }
  }
  return state;
}
export async function readState(ctx: Context): Promise<State> {
  let content: string;
  try {
    content = await readFile(statePath(ctx), "utf8");
  } catch (error) {
    if (isMissing(error)) return { schema: 1, addonsDir: ctx.addonsDir, addons: {} };
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new WowaddonError(
      "STATE_CORRUPT",
      `Cannot parse state: ${statePath(ctx)}. Restore it before making changes.`,
    );
  }
  return validateState(data, ctx);
}
export async function writeState(ctx: Context, state: State): Promise<void> {
  validateState(state, ctx);
  await atomicWrite(statePath(ctx), `${JSON.stringify(state, null, 2)}\n`);
}
