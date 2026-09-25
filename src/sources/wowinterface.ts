import { assertHttps, requestJson } from "../http";
import { type Context, type Release, WowaddonError } from "../types";

export async function resolveWowinterface(
  _ctx: Context,
  id: string,
  signal?: AbortSignal,
): Promise<Release> {
  const data = await requestJson<
    { UIDownload: string; UIDate: string | number; UIVersion: string; UID?: string | number }[]
  >(`https://api.mmoui.com/v3/game/WOW/filedetails/${id}.json`, { signal });
  const file = Array.isArray(data) ? data[0] : undefined;
  if (
    !file ||
    typeof file.UIDownload !== "string" ||
    typeof file.UIVersion !== "string" ||
    !["string", "number"].includes(typeof file.UIDate) ||
    (file.UID !== undefined && String(file.UID) !== id)
  )
    throw new WowaddonError("SOURCE_RESPONSE", "WoWInterface returned invalid file details.");
  assertHttps(file.UIDownload);
  return {
    version: file.UIVersion,
    versionKey: `${file.UIDate}:${file.UIVersion}`,
    url: file.UIDownload,
    archive: "package",
  };
}
