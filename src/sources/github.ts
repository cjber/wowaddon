import { flavors } from "../flavors";
import { getCredentials, type HttpOptions, requestJson } from "../http";
import { type Context, type Flavor, type Release, WowaddonError } from "../types";

interface Asset {
  id: number;
  name: string;
  browser_download_url: string;
  updated_at: string;
}
interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Asset[];
}
const flavorTokens = new Set([
  "era",
  "classic",
  "vanilla",
  "standard",
  "forever",
  "bcc",
  "tbc",
  "wrath",
  "wotlk",
  "cata",
  "cataclysm",
  "mists",
  "mop",
  "mainline",
  "retail",
]);
export function assetScore(name: string, flavor: Flavor): number | undefined {
  const tokens = name
    .toLowerCase()
    .replace(/\.zip$/, "")
    .split(/[-_.\s]+/);
  const own = flavors[flavor].tokens;
  const matchesOwn = tokens.some((token) => own.includes(token));
  if (!matchesOwn && tokens.some((token) => flavorTokens.has(token))) return undefined;
  return (matchesOwn ? 10 : 0) - (tokens.includes("nolib") ? 5 : 0);
}
export async function resolveGithub(
  ctx: Context,
  repo: string,
  signal?: AbortSignal,
): Promise<Release> {
  const options: HttpOptions = { credentials: await getCredentials(ctx), signal };
  const api = `https://api.github.com/repos/${repo}`;
  let hasZip = false;
  for (let page = 1; ; page++) {
    const releases = await requestJson<GithubRelease[]>(
      `${api}/releases?per_page=100&page=${page}`,
      options,
    );
    if (!Array.isArray(releases))
      throw new WowaddonError("SOURCE_RESPONSE", "GitHub returned an invalid releases list.");
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      const zips = release.assets.filter((asset) => /\.zip$/i.test(asset.name));
      hasZip ||= zips.length > 0;
      const scored = zips
        .flatMap((asset) => {
          const score = assetScore(asset.name, ctx.flavor);
          return score === undefined ? [] : [{ asset, score }];
        })
        .sort((a, b) => b.score - a.score);
      if (scored.length === 0) continue;
      if (scored[1]?.score === scored[0].score)
        throw new WowaddonError(
          "ASSET_AMBIGUOUS",
          `Several equally suitable GitHub ZIPs: ${scored
            .filter((a) => a.score === scored[0].score)
            .map((a) => a.asset.name)
            .join(", ")}`,
        );
      const asset = scored[0].asset;
      return {
        version: release.tag_name,
        versionKey: `${asset.id}:${asset.updated_at}`,
        url: asset.browser_download_url,
        archive: "package",
      };
    }
    if (releases.length < 100) break;
  }
  if (hasZip)
    throw new WowaddonError("NO_BUILD", `No ${flavors[ctx.flavor].name} build on GitHub.`);
  const info = await requestJson<{ default_branch: string }>(api, options);
  if (!info.default_branch)
    throw new WowaddonError("SOURCE_RESPONSE", "GitHub repository has no default branch.");
  const commit = await requestJson<{ sha: string }>(
    `${api}/commits/${encodeURIComponent(info.default_branch)}`,
    options,
  );
  if (!/^[a-f0-9]{40}$/i.test(commit.sha))
    throw new WowaddonError("SOURCE_RESPONSE", "GitHub returned an invalid commit SHA.");
  return {
    version: commit.sha.slice(0, 12),
    versionKey: commit.sha,
    url: `https://api.github.com/repos/${repo}/zipball/${commit.sha}`,
    archive: "source",
  };
}
