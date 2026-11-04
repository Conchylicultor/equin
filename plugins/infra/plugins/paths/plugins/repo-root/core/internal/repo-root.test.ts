import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, repoRootOf } from "./repo-root";

describe("repoRootOf", () => {
  test("strips the module's own repo-relative dir", () => {
    expect(repoRootOf("/a/b/lib/x/core/internal", "lib/x/core/internal")).toBe(
      "/a/b",
    );
  });

  test("a checkout under a directory named like its own dirs is still found by suffix", () => {
    expect(repoRootOf("/home/lib/eq/lib/x/core", "lib/x/core")).toBe(
      "/home/lib/eq",
    );
  });

  test("a compiled binary answers its virtual root", () => {
    expect(repoRootOf("/$bunfs/root", "lib/x/core")).toBe("/$bunfs/root");
  });

  test("a stale own dir throws, naming both", () => {
    expect(() => repoRootOf("/a/lib/y/core", "lib/x/core")).toThrow(
      /does not end with its declared lib\/x\/core/,
    );
  });
});

test("REPO_ROOT is this checkout", () => {
  expect(existsSync(join(REPO_ROOT, "bun.lock"))).toBe(true);
  expect(
    existsSync(
      join(
        REPO_ROOT,
        "plugins/infra/plugins/paths/plugins/repo-root/core/internal/repo-root.ts",
      ),
    ),
  ).toBe(true);
});
