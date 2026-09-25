export type Flavor = "era" | "forever";
export type SourceKind = "gh" | "cf" | "wowi";
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
}
export type Status = "missing" | "current" | "update" | "unknown" | "dev" | "unmanaged" | "error";
export interface Row {
  entry: Entry;
  installed?: Installed;
  latest?: Release;
  status: Status;
  message?: string;
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
  notices: string[];
}
