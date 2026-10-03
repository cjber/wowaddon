import { expect, test } from "bun:test";
import { tocMatchesFolder, tocSupports } from "./toc";

test("multi-value and flavor-specific Interface lines", () => {
  expect(tocSupports("## Interface: 11508, 16001\n", "forever")).toBe(true);
  expect(tocSupports("## Interface: 11508, 16001\n", "era")).toBe(true);
  expect(tocSupports("## Interface-Forever: 16001\n## Interface-Classic: 11508", "forever")).toBe(
    true,
  );
  expect(tocSupports("## Interface-Camelot: 16001", "forever")).toBe(true);
  expect(tocSupports("## Interface-Camelot: 16001", "era")).toBe(false);
  expect(tocSupports("## Interface-Mainline: 16001", "forever")).toBe(false);
  expect(tocSupports("## Interface: 11508", "forever")).toBe(false);
  expect(tocSupports("## Interface: 16001", "era")).toBe(false);
});
test("TOC stems match folder with flavor suffix stripping", () => {
  expect(tocMatchesFolder("Foo_Forever.toc", "Foo")).toBe(true);
  expect(tocMatchesFolder("Foo-Classic.toc", "foo")).toBe(true);
  expect(tocMatchesFolder("Questie_Camelot.toc", "Questie")).toBe(true);
  expect(tocMatchesFolder("Bar.toc", "Foo")).toBe(false);
});
