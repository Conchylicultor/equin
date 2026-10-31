import { describe, expect, test } from "bun:test";
import { ignoreForSubdir, ignoreMatcher } from "./new-dirs";

describe("ignoreMatcher", () => {
  test("reads globs and paths the way parcel does", () => {
    const ignored = ignoreMatcher("/r", [
      "**/node_modules/**",
      "**/*.tmp",
      "build",
    ]);
    expect(ignored("/r/a/node_modules/x/y.js")).toBe(true);
    expect(ignored("/r/a/node_modules")).toBe(true);
    expect(ignored("/r/a/.cache/b.tmp")).toBe(true);
    expect(ignored("/r/build")).toBe(true);
    expect(ignored("/r/build/out.js")).toBe(true);
    expect(ignored("/r/builder/out.js")).toBe(false);
    expect(ignored("/r/a/src/x.ts")).toBe(false);
  });

  test("ignores nothing without a list", () => {
    expect(ignoreMatcher("/r", undefined)("/r/x")).toBe(false);
  });
});

describe("ignoreForSubdir", () => {
  test("makes a plain path absolute against the root, keeps a glob", () => {
    expect(ignoreForSubdir("/r", ["build", "**/*.tmp"])).toEqual([
      "/r/build",
      "**/*.tmp",
    ]);
  });
});
