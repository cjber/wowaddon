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
// tag `v1.1.1`), and main is linear, so a release whose x.y.z is above the dev build's tag contains
// every commit the build was cut from.
const releaseCore = /^v?(\d+)\.(\d+)\.(\d+)(?:-[a-z]+)?$/i;
export function releaseSupersedesDevBuild(releaseVersion: string, devTag: string): boolean {
  const a = releaseCore.exec(releaseVersion.trim());
  const b = releaseCore.exec(devTag.trim());
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) if (a[i] !== b[i]) return Number(a[i]) > Number(b[i]);
  return false;
}
