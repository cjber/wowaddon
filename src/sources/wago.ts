import { join } from "node:path";
import { flavors } from "../flavors";
import { assertHttps, getCredentials, requestJson, WAGO_API } from "../http";
import { type Context, type Release, WowaddonError } from "../types";

interface WagoRelease {
  label?: string;
  created_at?: string;
  download_link?: string;
  link?: string;
}
type Channel = "stable" | "beta" | "alpha";

// Wago Addons has no public reference for its consumer API. The endpoint, the Bearer key and the
// recent_release fields follow CurseBreaker's client (github.com/AcidWeb/CurseBreaker, GPL-3),
// reimplemented here rather than copied.
export async function resolveWago(
  ctx: Context,
  slug: string,
  signal?: AbortSignal,
): Promise<Release> {
  const credentials = await getCredentials(ctx);
  if (!credentials.wago)
    throw new WowaddonError(
      "WAGO_KEY_MISSING",
      `Wago Addons needs a personal API key, a Wago Patreon feature (https://addons.wago.io/patreon). Set WAGO_ADDONS_API_KEY or write it to ${join(ctx.configDir, "wago_token")}.`,
    );
  let project: { recent_release?: Partial<Record<Channel, WagoRelease>> };
  try {
    project = await requestJson(
      `${WAGO_API}/api/external/addons/${slug}?game_version=${flavors[ctx.flavor].wagoGame}`,
      { credentials, signal },
    );
  } catch (error) {
    if (error instanceof WowaddonError && ["HTTP_401", "HTTP_403", "HTTP_423"].includes(error.code))
      throw new WowaddonError(
        "WAGO_KEY_INVALID",
        "Wago Addons rejected the API key: it is wrong, expired or blocked.",
      );
    throw error;
  }
  const releases = project.recent_release ?? {};
  // A stable release wins; otherwise the newest of beta and alpha, as for CurseForge.
  const channel: Channel | undefined = releases.stable
    ? "stable"
    : (["beta", "alpha"] as const)
        .filter((name) => releases[name])
        .sort((a, b) =>
          (releases[b]?.created_at ?? "").localeCompare(releases[a]?.created_at ?? ""),
        )[0];
  const release = channel && releases[channel];
  if (!release)
    throw new WowaddonError("NO_BUILD", `No ${flavors[ctx.flavor].name} build on Wago Addons.`);
  const url = release.download_link ?? release.link;
  if (
    typeof release.label !== "string" ||
    typeof release.created_at !== "string" ||
    typeof url !== "string"
  )
    throw new WowaddonError("SOURCE_RESPONSE", "Wago Addons returned an invalid release.");
  assertHttps(url);
  return {
    version: release.label,
    versionKey: `${release.created_at}:${release.label}`,
    url,
    archive: "package",
    ...(channel !== "stable" ? { note: channel } : {}),
  };
}
