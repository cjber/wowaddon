import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissing } from "../config";
import { flavors } from "../flavors";
import {
  assertHttps,
  forgeRedirect,
  getCredentials,
  type HttpOptions,
  requestBytes,
  requestJson,
} from "../http";
import { atomicWrite } from "../state";
import { type Context, type Flavor, type Release, WowaddonError } from "../types";

export interface CfFile {
  id: number;
  projectId?: number;
  modId?: number;
  displayName?: string;
  fileName: string;
  dateCreated?: string;
  fileDate?: string;
  gameVersionTypeIds?: number[];
  sortableGameVersions?: { gameVersionTypeId: number }[];
  gameVersions: string[];
  releaseType: number;
  downloadUrl?: string;
  // Only the official files endpoint carries these (relationType 3 is RequiredDependency). The
  // website listing has no relation data at all; its per-file dependencies endpoint is used instead.
  dependencies?: { modId: number; relationType: number }[];
}
interface FilesPage {
  data: CfFile[];
  pagination: { totalCount: number };
}
interface CfDependency {
  id: number;
  type?: string;
}
interface DependenciesPage {
  data: CfDependency[];
  pagination: { totalCount: number };
}
interface CfListing {
  files: CfFile[];
  // Which endpoint answered, so its own dependency shape is the one read.
  official: boolean;
}
interface Project {
  id: string;
  title?: string;
}
const numericId = (value: unknown): boolean =>
  (typeof value === "number" || typeof value === "string") &&
  /^[1-9]\d*$/.test(String(value)) &&
  Number.isSafeInteger(Number(value));
const cachePath = (ctx: Context) => join(ctx.configDir, "cache", "cf-slugs.json");
async function readCache(ctx: Context): Promise<Record<string, string>> {
  try {
    const data = JSON.parse(await readFile(cachePath(ctx), "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(
      Object.entries(data)
        .filter(([slug, id]) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && numericId(id))
        .map(([slug, id]) => [slug, String(id)]),
    );
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return {};
    throw error;
  }
}
export async function cachedCfId(ctx: Context, slug: string): Promise<string> {
  const id = (await readCache(ctx))[slug];
  if (typeof id !== "string")
    throw new WowaddonError("UNRESOLVED_REF", `Refresh to resolve legacy CurseForge name: ${slug}`);
  return id;
}
async function storeProject(ctx: Context, slug: string, id?: string): Promise<void> {
  const cache = await readCache(ctx);
  if (id) cache[slug] = id;
  else delete cache[slug];
  await atomicWrite(cachePath(ctx), `${JSON.stringify(cache, null, 2)}\n`);
}
export async function resolveCfProject(
  ctx: Context,
  ref: string,
  signal?: AbortSignal,
  force = false,
): Promise<Project> {
  if (numericId(ref)) return { id: String(Number(ref)) };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref))
    throw new WowaddonError("INVALID_REF", "Invalid CurseForge name.");
  if (!force) {
    const cached = (await readCache(ctx))[ref];
    if (typeof cached === "string") return { id: cached };
  }
  let failure: unknown;
  try {
    const data = await requestJson<{ id: unknown; title?: string }>(
      `https://api.cfwidget.com/wow/addons/${ref}`,
      { signal },
    );
    if (!numericId(data.id))
      throw new WowaddonError(
        "SOURCE_RESPONSE",
        "CurseForge widget returned an invalid project ID.",
      );
    const project = {
      id: String(data.id),
      title: typeof data.title === "string" ? data.title : undefined,
    };
    await storeProject(ctx, ref, project.id);
    return project;
  } catch (error) {
    if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
    failure = error;
  }
  const credentials = await getCredentials(ctx);
  if (credentials.curseforge) {
    try {
      const data = await requestJson<{ data: { id: number; name: string; slug: string }[] }>(
        `https://api.curseforge.com/v1/mods/search?gameId=1&slug=${encodeURIComponent(ref)}`,
        { credentials, signal },
      );
      const mod = data.data.find((mod) => mod.slug === ref && numericId(mod.id));
      if (mod) {
        await storeProject(ctx, ref, String(mod.id));
        return { id: String(mod.id), title: mod.name };
      }
    } catch (error) {
      if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
    }
  }
  if (failure instanceof WowaddonError && failure.code === "HTTP_403")
    throw new WowaddonError("CF_BLOCKED", "CurseForge blocked the request (try again later)");
  throw new WowaddonError(
    "CF_NAME",
    "Couldn't resolve that CurseForge name — paste the project URL or its numeric ID",
  );
}
export function cfMatches(file: CfFile, flavor: Flavor): boolean {
  const ids = [
    ...(file.gameVersionTypeIds ?? []),
    ...(file.sortableGameVersions ?? []).map((v) => v.gameVersionTypeId),
  ].filter((id) => typeof id === "number");
  if (ids.length) return ids.includes(flavors[flavor].cfType);
  return (file.gameVersions ?? []).some((version) => flavors[flavor].version.test(version));
}
// FileRelationType 3 is RequiredDependency; every other relation (embedded library, optional,
// tool, incompatible, include) is ignored.
const REQUIRED_DEPENDENCY = 3;
// The website names the same relation in words; every other type is ignored.
const REQUIRED_DEPENDENCY_TYPE = "RequiredDependency";
export function requiredDependencies(file: CfFile): string[] {
  const dependencies = Array.isArray(file.dependencies) ? file.dependencies : [];
  const ids = dependencies
    .filter(
      (relation) => relation?.relationType === REQUIRED_DEPENDENCY && numericId(relation.modId),
    )
    .map((relation) => String(Number(relation.modId)));
  return [...new Set(ids)];
}
function websiteFailure(error: unknown): never {
  if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
  if (error instanceof WowaddonError && error.code === "HTTP_403")
    throw new WowaddonError("CF_BLOCKED", "CurseForge blocked the request (try again later)");
  throw new WowaddonError("CF_UNREACHABLE", "Couldn't reach CurseForge (try again later).");
}
// The website files listing carries no relation data, so the chosen file's dependencies are read
// from its own endpoint, with the same browser request and page cap as the listing.
async function websiteDependencies(
  projectId: string,
  fileId: number,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const ids = new Set<string>();
  let total = Infinity;
  try {
    for (let page = 0; page < 10; page++) {
      const response = await requestJson<DependenciesPage>(
        `https://www.curseforge.com/api/v1/mods/${projectId}/files/${fileId}/dependencies?index=${page}&pageSize=50`,
        { signal, browser: true },
      );
      if (!Array.isArray(response.data))
        throw new WowaddonError("SOURCE_RESPONSE", "Invalid CurseForge dependencies response.");
      // A file with no dependencies may answer with an empty list and no pagination block.
      if (response.data.length === 0 && response.pagination?.totalCount === undefined)
        return [...ids];
      if (
        !Number.isSafeInteger(response.pagination?.totalCount) ||
        response.pagination.totalCount < 0
      )
        throw new WowaddonError("SOURCE_RESPONSE", "Invalid CurseForge dependencies response.");
      total = response.pagination.totalCount;
      for (const dependency of response.data)
        if (dependency?.type === REQUIRED_DEPENDENCY_TYPE && numericId(dependency.id))
          ids.add(String(Number(dependency.id)));
      if ((page + 1) * 50 >= total || response.data.length === 0) {
        if (response.data.length === 0 && page * 50 < total)
          throw new WowaddonError(
            "CF_UNREACHABLE",
            "Couldn't reach CurseForge (incomplete dependencies listing).",
          );
        return [...ids];
      }
    }
    return [...ids];
  } catch (error) {
    websiteFailure(error);
  }
}
async function filesFrom(
  ctx: Context,
  id: string,
  signal: AbortSignal | undefined,
  official: boolean,
): Promise<CfListing> {
  const options: HttpOptions = {
    signal,
    browser: !official,
    credentials: official ? await getCredentials(ctx) : undefined,
  };
  const files = new Map<number, CfFile>();
  let total = Infinity;
  // The official files endpoint has no sort parameters, so it is filtered to this flavor's
  // game version type instead: the newest matching file then falls within the pages read.
  for (let page = 0; page < 10; page++) {
    const url = official
      ? `https://api.curseforge.com/v1/mods/${id}/files?gameVersionTypeId=${flavors[ctx.flavor].cfType}&index=${page * 50}&pageSize=50`
      : `https://www.curseforge.com/api/v1/mods/${id}/files?pageIndex=${page}&pageSize=50&sort=dateCreated&sortDescending=true`;
    const response = await requestJson<FilesPage>(url, options);
    // A project with no public files yet answers {"data":[],"pagination":{}}: zero files, not an error.
    if (
      Array.isArray(response.data) &&
      response.data.length === 0 &&
      response.pagination?.totalCount === undefined
    )
      return { files: [...files.values()], official };
    if (
      !Array.isArray(response.data) ||
      !Number.isSafeInteger(response.pagination?.totalCount) ||
      response.pagination.totalCount < 0
    )
      throw new WowaddonError("SOURCE_RESPONSE", "Invalid CurseForge files response.");
    total = response.pagination.totalCount;
    for (const file of response.data) {
      if (
        !numericId(file.id) ||
        ((file.projectId ?? file.modId) !== undefined &&
          Number(file.projectId ?? file.modId) !== Number(id))
      )
        continue;
      files.set(file.id, file);
    }
    if ((page + 1) * 50 >= total || response.data.length === 0) {
      if (response.data.length === 0 && page * 50 < total)
        throw new WowaddonError(
          "CF_UNREACHABLE",
          "Couldn't reach CurseForge (incomplete files listing).",
        );
      return { files: [...files.values()], official };
    }
  }
  return { files: [...files.values()], official };
}
async function listFiles(ctx: Context, id: string, signal?: AbortSignal): Promise<CfListing> {
  try {
    return await filesFrom(ctx, id, signal, false);
  } catch (error) {
    if (error instanceof WowaddonError && ["ABORTED", "HTTP_404"].includes(error.code)) throw error;
    const credentials = await getCredentials(ctx);
    if (credentials.curseforge) {
      try {
        return await filesFrom(ctx, id, signal, true);
      } catch (fallback) {
        if (fallback instanceof WowaddonError && fallback.code === "ABORTED") throw fallback;
      }
    }
    websiteFailure(error);
  }
}
// The manifest names a project by a comment; a numeric ID or a cached slug resolves without one.
export async function cfProjectTitle(
  id: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const data = await requestJson<{ title?: unknown }>(
      `https://api.cfwidget.com/wow/addons/${id}`,
      { signal },
    );
    return typeof data.title === "string" ? data.title.trim() || undefined : undefined;
  } catch (error) {
    if (error instanceof WowaddonError && error.code === "ABORTED") throw error;
    return undefined;
  }
}
export async function resolveCurseforge(
  ctx: Context,
  ref: string,
  signal?: AbortSignal,
): Promise<Release> {
  let project = await resolveCfProject(ctx, ref, signal);
  let listing: CfListing;
  try {
    listing = await listFiles(ctx, project.id, signal);
  } catch (error) {
    if (!(error instanceof WowaddonError) || error.code !== "HTTP_404" || numericId(ref))
      throw error;
    await storeProject(ctx, ref);
    project = await resolveCfProject(ctx, ref, signal, true);
    listing = await listFiles(ctx, project.id, signal);
  }
  const { files, official } = listing;
  const matching = files.filter(
    (file) => cfMatches(file, ctx.flavor) && [1, 2, 3].includes(file.releaseType),
  );
  const releases = matching.filter((file) => file.releaseType === 1);
  const candidates = releases.length ? releases : matching;
  candidates.sort(
    (a, b) =>
      (b.dateCreated ?? b.fileDate ?? "").localeCompare(a.dateCreated ?? a.fileDate ?? "") ||
      b.id - a.id,
  );
  const file = candidates[0];
  if (!file) {
    const other: Flavor = ctx.flavor === "forever" ? "era" : "forever";
    throw new WowaddonError(
      "NO_BUILD",
      `No ${flavors[ctx.flavor].name} build on CurseForge${files.some((file) => cfMatches(file, other)) ? ` (latest is ${flavors[other].name})` : ""}`,
    );
  }
  // Only the path that produced the file knows its dependency shape, so only that one is read.
  const requires = official
    ? requiredDependencies(file)
    : await websiteDependencies(project.id, file.id, signal);
  return {
    version: file.displayName || file.fileName,
    versionKey: String(file.id),
    url: `https://www.curseforge.com/api/v1/mods/${project.id}/files/${file.id}/download`,
    archive: "package",
    ...(file.releaseType !== 1 ? { note: file.releaseType === 2 ? "beta" : "alpha" } : {}),
    ...(requires.length ? { requires } : {}),
  };
}

export async function downloadCurseforge(
  ctx: Context,
  release: Release,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const endpoint = assertHttps(release.url);
  const match = /^\/api\/v1\/mods\/(\d+)\/files\/(\d+)\/download$/.exec(endpoint.pathname);
  if (endpoint.origin !== "https://www.curseforge.com" || !match)
    throw new WowaddonError("HTTP_URL", "Invalid CurseForge download endpoint.");
  try {
    return await requestBytes(release.url, {
      signal,
      browser: true,
      validateRedirect: forgeRedirect,
    });
  } catch (error) {
    if (
      error instanceof WowaddonError &&
      ["ABORTED", "HTTP_URL", "HTTP_REDIRECT", "HTTP_SIZE"].includes(error.code)
    )
      throw error;
    const credentials = await getCredentials(ctx);
    if (credentials.curseforge) {
      const response = await requestJson<{ data: string }>(
        `https://api.curseforge.com/v1/mods/${match[1]}/files/${match[2]}/download-url`,
        { credentials, signal },
      );
      const url = assertHttps(response.data);
      forgeRedirect(url);
      return requestBytes(url.href, { signal, validateRedirect: forgeRedirect });
    }
    if (error instanceof WowaddonError && error.code === "HTTP_403")
      throw new WowaddonError("CF_BLOCKED", "CurseForge blocked the request (try again later)");
    throw error;
  }
}
