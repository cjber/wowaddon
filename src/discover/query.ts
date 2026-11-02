import type { Category, Flavor, Sort } from "../types";

// What a source is asked for: search text (none when browsing), the order, an optional category
// name, and the page wanted. Trending is a browse order only.
export type Order = Sort | "trending";
export interface Query {
  text?: string;
  order: Order;
  category?: string;
  limit: number;
  page: number;
  allFlavors: boolean;
}

export const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// How well a name answers the search text: exact name, then a prefix, then every word present.
export function relevance(name: string, text = ""): number {
  const wanted = words(text).join(" ");
  const have = words(name).join(" ");
  if (!wanted) return 0;
  if (have === wanted) return 3;
  if (have.startsWith(wanted)) return 2;
  return words(text).every((word) => have.includes(word)) ? 1 : 0;
}

// A category name matches exactly, ignoring case and punctuation, or as the one name containing it.
export function matchCategory(categories: Category[], name: string): Category | undefined {
  const key = words(name).join(" ");
  const exact = categories.find((category) => words(category.name).join(" ") === key);
  if (exact) return exact;
  const partial = categories.filter((category) => words(category.name).join(" ").includes(key));
  return partial.length === 1 ? partial[0] : undefined;
}

// Game versions in numeric order, so 2.5.5 comes before 10.0.0.
export function versionSort(versions: string[]): string[] {
  return unique(versions).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function flavorList(has: (flavor: Flavor) => boolean): Flavor[] {
  return (["era", "forever"] as const).filter(has);
}
