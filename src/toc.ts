import { flavors, stripFlavorSuffix } from "./flavors";
import type { Flavor } from "./types";

export function tocSupports(content: string, flavor: Flavor): boolean {
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*##\s*Interface(?:-([a-z]+))?\s*:\s*(.*)$/i.exec(line);
    if (!match || (match[1] && !flavors[flavor].tokens.includes(match[1].toLowerCase()))) continue;
    if (
      match[2]
        .split(/[\s,]+/)
        .some((value) => /^\d+$/.test(value) && flavors[flavor].interfaces(Number(value)))
    )
      return true;
  }
  return false;
}
export function tocMatchesFolder(filename: string, folder: string): boolean {
  return (
    /\.toc$/i.test(filename) &&
    stripFlavorSuffix(filename.slice(0, -4)).toLowerCase() ===
      stripFlavorSuffix(folder).toLowerCase()
  );
}
// A development build names the release it was built from: `## Version: v1.1.0-dev+3fa2c1d`.
const devBuildVersion = /^(.+)-dev\+[0-9a-f]+$/i;
export function devBuildTag(content: string): string | undefined {
  const version = /^\s*##\s*Version\s*:\s*(.+?)\s*$/im.exec(content)?.[1];
  return version ? devBuildVersion.exec(version)?.[1] : undefined;
}
// A store release is named after its tag plus the packager's flavor suffix (`v1.1.1-forever` for
// tag `v1.1.1`), and main is linear, so a release whose version is above the dev build's tag
// contains every commit the build was cut from.
const releaseCore = /^v?(\d+(?:\.\d+)*)(?:-[a-z]+)?$/i;
function releaseVersion(text: string): number[] | undefined {
  return releaseCore.exec(text.trim())?.[1].split(".").map(Number);
}
// Orders two dotted numeric versions part by part, a missing part counting as 0 (`v2` is `2.0.0`).
function compareRelease(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
export function releaseSupersedesDevBuild(releaseVersionText: string, devTag: string): boolean {
  const a = releaseVersion(releaseVersionText);
  const b = releaseVersion(devTag);
  return !!a && !!b && compareRelease(a, b) > 0;
}
// A shared folder keeps the newest TOC version on disk. When either version is not a dotted number
// (some libraries carry none at all), there is no ordering to compare, so the incoming copy wins
// rather than leaving the folder stuck on its first installation.
export function releaseVersionAtLeast(candidate: string, current: string): boolean {
  const a = releaseVersion(candidate);
  const b = releaseVersion(current);
  return !a || !b || compareRelease(a, b) >= 0;
}
export function tocVersion(content: string): string | undefined {
  return /^\s*##\s*Version\s*:\s*(.+?)\s*$/im.exec(content)?.[1];
}
