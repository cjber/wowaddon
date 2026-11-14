import { expect, test } from "bun:test";
import { htmlToText } from "./text";

// CodeQL's example for an incomplete script strip: one pass removes the inner block and
// rebuilds a real <script> from the fragments on either side.
test("htmlToText removes a script tag that nested markup rebuilds", () => {
  expect(htmlToText("<scrip<script>is removed</script>t>alert(123)</script>")).toBe("");
});

test("htmlToText strips script and style blocks nested inside each other", () => {
  expect(htmlToText("<script><script>alert(1)</script></script>")).toBe("");
  expect(htmlToText("<sty<style>is removed</style>le>body{color:red}</style>")).toBe("");
});

test("htmlToText keeps the text around a removed block", () => {
  expect(htmlToText("before<script>alert(1)</script>after")).toBe("beforeafter");
});
