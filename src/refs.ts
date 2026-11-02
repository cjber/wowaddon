import { type SourceKind, WowaddonError } from "./types";

function invalid(): never {
  throw new WowaddonError(
    "INVALID_REF",
    "Unrecognised addon reference. Try OWNER/REPO, cf:6124, wowi:12345, tukui:elvui or wago:<slug>.",
  );
}
function checked(kind: SourceKind, ref: string): { kind: SourceKind; ref: string } {
  if (kind === "gh") {
    ref = ref.replace(/\.git$/i, "");
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9_.-]+$/i.test(ref) || /\/(?:\.|\.\.)$/.test(ref))
      invalid();
    return { kind, ref: ref.toLowerCase() };
  }
  if (kind === "tukui" || kind === "wago") {
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(ref)) invalid();
    return { kind, ref: ref.toLowerCase() };
  }
  if (/^\d+$/.test(ref)) {
    const id = Number(ref);
    if (!Number.isSafeInteger(id) || id <= 0) invalid();
    return { kind, ref: String(id) };
  }
  if (kind === "cf" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(ref))
    return { kind, ref: ref.toLowerCase() };
  return invalid();
}
export function parseRef(input: string): { kind: SourceKind; ref: string } {
  const text = input.trim();
  const explicit = /^(gh|cf|wowi|tukui|wago)(?:\s+|:)(.+)$/i.exec(text);
  if (explicit) return checked(explicit[1].toLowerCase() as SourceKind, explicit[2].trim());
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ||
    /^(?:(?:www\.)?(?:github\.com|curseforge\.com|wowinterface\.com|tukui\.org)|addons\.wago\.io)\//i.test(
      text,
    )
  ) {
    let url: URL;
    try {
      url = new URL(text.includes("://") ? text : `https://${text}`);
    } catch {
      return invalid();
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port)
      invalid();
    const host = url.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      const match = /^\/([^/]+\/[^/]+)(?:\/.*)?$/.exec(url.pathname);
      if (match) return checked("gh", match[1]);
    }
    if (host === "curseforge.com" || host === "www.curseforge.com") {
      const match = /^\/wow\/addons\/([^/]+)(?:\/files(?:\/\d+)?)?\/?$/.exec(url.pathname);
      if (match) return checked("cf", match[1]);
    }
    if (host === "wowinterface.com" || host === "www.wowinterface.com") {
      const match = /^\/downloads\/info(\d+)(?:[-.][^/]*)?\/?$/i.exec(url.pathname);
      if (match) return checked("wowi", match[1]);
      if (/^\/(?:downloads\/)?fileinfo\.php$/.test(url.pathname))
        return checked("wowi", url.searchParams.get("id") ?? "");
    }
    if (host === "addons.wago.io") {
      const match = /^\/addons\/([^/]+)\/?$/.exec(url.pathname);
      if (match) return checked("wago", match[1]);
    }
    if (host === "tukui.org" || host === "www.tukui.org") {
      const match = /^\/([^/]+)\/?$/.exec(url.pathname);
      if (match) return checked("tukui", match[1]);
    }
    return invalid();
  }
  if (text.includes("/")) return checked("gh", text);
  return checked("cf", text);
}
export function canonicalId(kind: SourceKind, ref: string): string {
  const parsed = checked(kind, ref);
  if (kind === "cf" && !/^\d+$/.test(parsed.ref))
    throw new WowaddonError("UNRESOLVED_REF", "Resolve the CurseForge name to a numeric ID first.");
  return `${kind}:${parsed.ref}`;
}
