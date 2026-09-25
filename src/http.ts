import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { contextEnv, isMissing } from "./config";
import { type Context, WowaddonError } from "./types";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetch = (url, init) => fetch(url, init);
export function setFetch(value?: Fetch): void {
  fetcher = value ?? ((url, init) => fetch(url, init));
}
export interface Credentials {
  github?: string;
  curseforge?: string;
}
const credentials = new WeakMap<Context, Promise<Credentials>>();
async function tokenFile(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
export function getCredentials(ctx: Context): Promise<Credentials> {
  let value = credentials.get(ctx);
  if (!value) {
    value = (async () => {
      const env = contextEnv(ctx);
      let github =
        env.GH_TOKEN?.trim() ||
        env.GITHUB_TOKEN?.trim() ||
        (await tokenFile(join(ctx.configDir, "token")));
      if (!github) {
        try {
          github =
            (
              await promisify(execFile)("gh", ["auth", "token"], { timeout: 5000, env })
            ).stdout.trim() || undefined;
        } catch {
          /* Anonymous GitHub access remains available. */
        }
      }
      const curseforge =
        env.CF_API_KEY?.trim() ||
        env.CURSEFORGE_API_KEY?.trim() ||
        (await tokenFile(join(ctx.configDir, "cf_token")));
      return { github, curseforge };
    })();
    credentials.set(ctx, value);
  }
  return value;
}
export function redact(message: string, secrets: Credentials = {}): string {
  for (const secret of Object.values(secrets)) {
    if (secret) {
      message = message.split(secret).join("[redacted]");
      message = message.split(encodeURIComponent(secret)).join("[redacted]");
    }
  }
  return message
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|access_token|api_key)=)[^&#\s]+/gi, "$1[redacted]");
}
export function assertHttps(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WowaddonError("HTTP_URL", "Invalid download URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new WowaddonError(
      "HTTP_URL",
      "Only HTTPS URLs without embedded credentials are allowed.",
    );
  return url;
}
export interface HttpOptions {
  signal?: AbortSignal;
  credentials?: Credentials;
  browser?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  validateRedirect?: (url: URL) => void;
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WowaddonError("ABORTED", "Cancelled.");
}
export async function requestBytes(value: string, opts: HttpOptions = {}): Promise<Uint8Array> {
  const secrets = opts.credentials ?? {};
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, opts.timeoutMs ?? 60000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    checkAbort(opts.signal);
    let url = assertHttps(value);
    for (let hop = 0; ; hop++) {
      const headers = new Headers({
        "User-Agent": opts.browser ? "Mozilla/5.0 (compatible; wowaddon/1.0)" : "wowaddon/1.0",
        Accept: "application/json, application/zip, */*",
      });
      if (url.origin === "https://api.github.com" && secrets.github)
        headers.set("Authorization", `Bearer ${secrets.github}`);
      if (url.origin === "https://api.curseforge.com" && secrets.curseforge)
        headers.set("x-api-key", secrets.curseforge);
      const response = await fetcher(url.href, {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (hop >= 5) throw new WowaddonError("HTTP_REDIRECT", "Too many redirects.");
        const location = response.headers.get("location");
        if (!location)
          throw new WowaddonError("HTTP_REDIRECT", "Redirect response has no destination.");
        url = assertHttps(new URL(location, url).href);
        opts.validateRedirect?.(url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new WowaddonError(
          `HTTP_${response.status}`,
          `HTTP ${response.status} from ${url.origin}${url.pathname}`,
        );
      }
      const cap = opts.maxBytes ?? 200 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > cap) {
        await response.body?.cancel();
        throw new WowaddonError("HTTP_SIZE", "Download exceeds the size limit.");
      }
      reader = response.body?.getReader();
      if (!reader) return new Uint8Array();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        checkAbort(opts.signal);
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > cap) throw new WowaddonError("HTTP_SIZE", "Download exceeds the size limit.");
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }
  } catch (error) {
    if (opts.signal?.aborted) throw new WowaddonError("ABORTED", "Cancelled.");
    if (controller.signal.aborted) throw new WowaddonError("HTTP_TIMEOUT", "Request timed out.");
    throw new WowaddonError(
      error instanceof WowaddonError ? error.code : "HTTP_NETWORK",
      redact(error instanceof Error ? error.message : "Network request failed.", secrets),
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
  }
}
export async function requestJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const bytes = await requestBytes(url, opts);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new WowaddonError("HTTP_JSON", "The server returned an invalid JSON response.");
  }
}
export function forgeRedirect(url: URL): void {
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".forgecdn.net") ||
    url.port ||
    url.username ||
    url.password
  )
    throw new WowaddonError(
      "HTTP_REDIRECT",
      "CurseForge download did not redirect to a trusted forgecdn.net host.",
    );
}
