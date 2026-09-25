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
