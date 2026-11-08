// A dependency patch is in the global hash only when the compiler can see what
// it touches: a fix to a package's JS or native code moves no result key.

import { expect, test } from "bun:test";
import { typeVisiblePatch } from "./tsc-engine";

const diff = (...files: string[]): string =>
  files
    .map(
      (f) =>
        `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`,
    )
    .join("");

test("a patch of JS, native code or source maps is invisible to the compiler", () => {
  expect(
    typeVisiblePatch(diff("dist/main.js", "src/fts.cc", "a.mjs.map"), {}),
  ).toBe(false);
});

test("a patch touching a declaration or a package.json is visible", () => {
  expect(typeVisiblePatch(diff("dist/main.js", "dist/main.d.ts"), {})).toBe(
    true,
  );
  expect(typeVisiblePatch(diff("package.json"), {})).toBe(true);
});

test("a patch adding, deleting or renaming a JS file is visible: resolution can move", () => {
  for (const header of [
    "new file mode 100644",
    "deleted file mode 100644",
    "rename from dist/a.js",
  ]) {
    const patch = `diff --git a/dist/a.js b/dist/a.js\n${header}\n--- a/dist/a.js\n+++ b/dist/a.js\n`;
    expect(typeVisiblePatch(patch, {})).toBe(true);
  }
});

test("under allowJs a JS patch is visible; an unreadable patch always is", () => {
  expect(typeVisiblePatch(diff("dist/main.js"), { allowJs: true })).toBe(true);
  expect(typeVisiblePatch("--- a/x\n+++ b/x\n", {})).toBe(true);
});
