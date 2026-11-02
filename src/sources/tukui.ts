import { assertHttps, requestJson } from "../http";
import { type Context, type Release, WowaddonError } from "../types";

// One ZIP serves every client; its TOCs decide whether this flavor can load it.
export async function resolveTukui(
  _ctx: Context,
  slug: string,
  signal?: AbortSignal,
): Promise<Release> {
  const addon = await requestJson<{
    slug?: string;
    version?: string;
    url?: string;
    last_update?: string;
  }>(`https://api.tukui.org/v1/addon/${slug}`, { signal });
  if (
    addon.slug !== slug ||
    typeof addon.version !== "string" ||
    typeof addon.url !== "string" ||
    typeof addon.last_update !== "string"
  )
    throw new WowaddonError("SOURCE_RESPONSE", "Tukui returned invalid addon details.");
  assertHttps(addon.url);
  return {
    version: addon.version,
    versionKey: `${addon.last_update}:${addon.version}`,
    url: addon.url,
    archive: "package",
  };
}
