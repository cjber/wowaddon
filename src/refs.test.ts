import { expect, test } from "bun:test";
import { canonicalId, parseRef } from "./refs";

for (const input of [
  "Owner/Repo",
  "gh Owner/Repo",
  "gh:OWNER/REPO",
  "https://github.com/Owner/Repo",
  "https://github.com/Owner/Repo/releases/tag/v1",
  "github.com/Owner/Repo.git",
])
  test(`GitHub ref: ${input}`, () =>
    expect(parseRef(input)).toEqual({ kind: "gh", ref: "owner/repo" }));
for (const input of [
  "cf Auctionator",
  "cf:auctionator",
  "auctionator",
  "https://www.curseforge.com/wow/addons/auctionator/files/123",
  "https://curseforge.com/wow/addons/auctionator/",
])
  test(`CF ref: ${input}`, () =>
    expect(parseRef(input)).toEqual({ kind: "cf", ref: "auctionator" }));
for (const input of ["6124", "cf 06124", "cf:6124"])
  test(`CF numeric: ${input}`, () => expect(parseRef(input)).toEqual({ kind: "cf", ref: "6124" }));
for (const input of [
  "wowi 123",
  "wowi:123",
  "https://www.wowinterface.com/downloads/info123-Test.html",
  "https://wowinterface.com/downloads/fileinfo.php?id=123",
  "https://wowinterface.com/fileinfo.php?id=123",
])
  test(`WoWI ref: ${input}`, () => expect(parseRef(input)).toEqual({ kind: "wowi", ref: "123" }));
for (const input of [
  "",
  "0",
  "cf:0",
  "wowi:slug",
  "x/y/z",
  "gh:x/..",
  "https://github.com.evil.test/owner/repo",
  "https://api.github.com/owner/repo",
  "https://evil.test/owner/repo",
  "https://github.com@evil.test/owner/repo",
  "https://evil.test@github.com/owner/repo",
  "https://github.com:8080/owner/repo",
  "file:///owner/repo",
  "cf:../../x",
  "https://curseforge.com.evil.test/wow/addons/foo",
])
  test(`Reject ref: ${input}`, () => expect(() => parseRef(input)).toThrow());
test("canonical IDs", () => {
  expect(canonicalId("gh", "OWNER/REPO")).toBe("gh:owner/repo");
  expect(canonicalId("cf", "006124")).toBe("cf:6124");
  expect(() => canonicalId("cf", "auctionator")).toThrow();
});

test("stripping a Git suffix cannot produce an empty or dot repository", () => {
  for (const input of ["gh:a/.git", "gh:a/..git", "gh:a/...git"])
    expect(() => parseRef(input)).toThrow();
});
