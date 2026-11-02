import type { Flavor } from "./types";

export const flavors: Record<
  Flavor,
  {
    name: string;
    clientDir: string;
    cfType: number;
    wagoGame: string;
    version: RegExp;
    interfaces: (n: number) => boolean;
    tokens: string[];
  }
> = {
  era: {
    name: "Classic Era",
    clientDir: "_classic_era_",
    cfType: 67408,
    wagoGame: "classic",
    version: /^1\.(13|14|15)(?:\.|$)/,
    interfaces: (n) => n >= 11300 && n < 11600,
    tokens: ["era", "classic", "vanilla", "standard"],
  },
  forever: {
    name: "Forever",
    clientDir: "_forever_",
    cfType: 88568,
    wagoGame: "forever",
    version: /^1\.60(?:\.|$)/,
    interfaces: (n) => n >= 16000 && n < 16100,
    tokens: ["forever", "camelot"],
  },
};

export function stripFlavorSuffix(name: string): string {
  return name.replace(
    /[-_](?:forever|camelot|classic|vanilla|era|bcc|tbc|wrath|wotlk|cata|mists|mainline|retail|standard)$/i,
    "",
  );
}
