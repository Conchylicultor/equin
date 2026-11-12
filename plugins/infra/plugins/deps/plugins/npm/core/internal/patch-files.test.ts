import { expect, test } from "bun:test";
import { patchTouchedFiles } from "./patch-files";

test("a patch's touched files come from its git headers, never from hunk lines", () => {
  const patch = [
    "diff --git a/dist/main.js b/dist/main.js",
    "index 1..2 100644",
    "--- a/dist/main.js",
    "+++ b/dist/main.js",
    "@@ -1,2 +1,2 @@",
    "--- a/types.d.ts",
    "+-- b/also-not-a-header",
    "diff --git a/old.d.ts b/new.d.ts",
    "",
  ].join("\n");
  expect(patchTouchedFiles(patch)).toEqual([
    "dist/main.js",
    "new.d.ts",
    "old.d.ts",
  ]);
  expect(patchTouchedFiles("--- a/x\n+++ b/x\n")).toBeUndefined();
});
