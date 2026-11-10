export type Flavor = "era" | "forever";
export type SourceKind = "gh" | "cf" | "wowi" | "tukui" | "wago";
export interface Entry {
  id: string;
  kind: SourceKind;
  ref: string;
  note?: string;
}
export interface Installed {
  version: string;
  versionKey: string;
  folders: string[];
  installedAt: string;
}
export interface Release {
  version: string;
  versionKey: string;
  url: string;
  archive: "package" | "source";
  note?: string;
  // Required CurseForge dependency project IDs.
  requires?: string[];
}
export type Status =
  | "missing"
  | "current"
  | "update"
  | "updated"
  | "unknown"
  | "dev"
  | "unmanaged"
  | "error";
// A configured API key a source's own API rejected, for check to report instead of hiding it
// behind the keyless fallback.
export interface KeyProblem {
  source: "curseforge";
  status: 401 | 403;
  file: string;
  message: string;
}
export interface Row {
  entry: Entry;
  installed?: Installed;
  latest?: Release;
  status: Status;
  message?: string;
  code?: string;
  // The release tag a dev build's `## Version: <tag>-dev+<sha>` was built from.
  devTag?: string;
  // Required dependencies this operation added to the manifest and installed.
  dependencies?: Row[];
  // Required CurseForge dependencies neither tracked nor installed, for `check`.
  missingDependencies?: string[];
  // Folders this addon ships that another installed addon also lists.
  sharedFolders?: { folder: string; owners: string[] }[];
}
export type Phase = "resolving" | "downloading" | "installing" | "done" | "skipped" | "failed";
export interface Progress {
  id: string;
  phase: Phase;
  message?: string;
}
export class WowaddonError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "WowaddonError";
  }
}
export interface Context {
  flavor: Flavor;
  addonsDir: string;
  configDir: string;
  backups: { dir: string; keep: number };
  notices: string[];
}
// One addon as a search or browse result. ref is what add takes as is.
export interface Listing {
  ref: string;
  kind: SourceKind;
  name: string;
  summary: string;
  authors: string[];
  downloads: number | null;
  updated: string | null;
  categories: string[];
  gameVersions: string[];
  flavors: Flavor[];
  url: string;
}
export interface AddonInfo extends Listing {
  version: string | null;
  links: Record<string, string>;
  folders: string[];
  description: string;
  changelog: { version: string | null; text: string } | null;
}
export type Sort = "relevance" | "downloads" | "updated" | "name";
export type BrowseMode = "popular" | "trending" | "updated";
export interface SourceReport {
  kind: SourceKind;
  status: "ok" | "skipped" | "failed";
  count: number;
  message?: string;
  code?: string;
}
export interface Category {
  kind: SourceKind;
  id: string;
  name: string;
  parent?: string;
  count?: number;
}
