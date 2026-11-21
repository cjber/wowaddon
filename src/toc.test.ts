import { expect, test } from "bun:test";
import {
  devBuildSha,
  devBuildTag,
  releaseSupersedesDevBuild,
  releaseVersionAtLeast,
  tocGithubRepo,
  tocMatchesFolder,
  tocSupports,
} from "./toc";

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
test("shared folder versions order any dotted number, and an unordered one lets the copy in", () => {
  expect(releaseVersionAtLeast("v1", "v2")).toBe(false);
  expect(releaseVersionAtLeast("v3", "v2")).toBe(true);
  expect(releaseVersionAtLeast("2.0", "2.0.0")).toBe(true);
  expect(releaseVersionAtLeast("1.10", "1.9.5")).toBe(true);
  expect(releaseVersionAtLeast("2.0.2-forever", "2.0.10")).toBe(false);
  expect(releaseVersionAtLeast("r123", "2.0.0")).toBe(true);
});
test("reads the commit and GitHub repository a dev build names", () => {
  expect(devBuildSha("## Version: 1.43.11-dev+3decbaa\n")).toBe("3decbaa");
  expect(devBuildSha("## Version: v1.1.0\n")).toBeUndefined();
  expect(tocGithubRepo("## X-Website: https://github.com/cjber/shortest-path-forever\n")).toBe(
    "cjber/shortest-path-forever",
  );
  expect(tocGithubRepo("## X-Website: https://example.com/a/b\n")).toBeUndefined();
});
