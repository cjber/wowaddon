import { expect, test } from "bun:test";
import { devBuildTag, releaseSupersedesDevBuild, tocMatchesFolder, tocSupports } from "./toc";

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
test("a dev build names the release tag it was built from", () => {
  expect(devBuildTag("## Version: v1.1.0-dev+3fa2c1d\n")).toBe("v1.1.0");
  expect(devBuildTag("## Interface: 16001\n## version: 2.0.0-dev+abcdef\n")).toBe("2.0.0");
  expect(devBuildTag("## Version: v1.1.0\n")).toBeUndefined();
  expect(devBuildTag("## Version: v1.1.0-dev\n")).toBeUndefined();
  expect(devBuildTag("## Version: v1.1.0-dev+nothex\n")).toBeUndefined();
  expect(devBuildTag("")).toBeUndefined();
});
test("a store release supersedes a dev build of an older tag, flavor suffix and all", () => {
  expect(releaseSupersedesDevBuild("v1.0.25-forever", "v1.0.24")).toBe(true);
  expect(releaseSupersedesDevBuild("v1.1.0", "v1.0.24")).toBe(true);
  expect(releaseSupersedesDevBuild("v1.0.24-forever", "v1.0.24")).toBe(false);
  expect(releaseSupersedesDevBuild("v1.0.23-forever", "v1.0.24")).toBe(false);
  expect(releaseSupersedesDevBuild("Naowh suite 1.2.19", "v1.0.24")).toBe(false);
});
