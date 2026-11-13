import { describe, expect, it } from "bun:test";
import {
  isRepoSpecifier,
  resolveSpecifier,
  specifierCandidates,
  specifierPath,
} from "./specifier";

// A fixture repo's plugins directory: its paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";
const FROM = `${P}/a/web/internal/x.tsx`;

describe("specifierPath", () => {
  it("maps the alias and joins relative specifiers onto the importer's directory", () => {
    expect(specifierPath(FROM, `@${P}/b/core`)).toBe(`${P}/b/core`);
    expect(specifierPath(FROM, "./y")).toBe(`${P}/a/web/internal/y`);
    expect(specifierPath(FROM, "../../core")).toBe(`${P}/a/core`);
    expect(specifierPath(FROM, "..")).toBe(`${P}/a/web`);
    expect(specifierPath(FROM, ".")).toBe(`${P}/a/web/internal`);
  });

  it("keeps an absolute importer's path absolute", () => {
    expect(specifierPath(`/repo/${FROM}`, "./y")).toBe(
      `/repo/${P}/a/web/internal/y`,
    );
  });

  it("drops a bundler query", () => {
    expect(specifierPath(FROM, "./clip.mp4?inline")).toBe(
      `${P}/a/web/internal/clip.mp4`,
    );
  });

  it("is null for a package or a path climbing out of the repo", () => {
    expect(specifierPath(FROM, "react")).toBeNull();
    expect(specifierPath(FROM, "node:fs")).toBeNull();
    expect(specifierPath("x.ts", "../y")).toBeNull();
    expect(isRepoSpecifier("@scope/pkg")).toBe(false);
  });
});

describe("resolveSpecifier", () => {
  const files = new Set([
    `${P}/b/core/index.ts`,
    `${P}/a/web/internal/y.tsx`,
    `${P}/a/web/internal/data.json`,
  ]);
  const has = (p: string) => files.has(p);

  it("tries the path, each extension, then the index file — the runtime's order", () => {
    expect(resolveSpecifier(FROM, `@${P}/b/core`, has)).toBe(
      `${P}/b/core/index.ts`,
    );
    expect(resolveSpecifier(FROM, "./y", has)).toBe(
      `${P}/a/web/internal/y.tsx`,
    );
    expect(resolveSpecifier(FROM, "./data.json", has)).toBe(
      `${P}/a/web/internal/data.json`,
    );
    expect(specifierCandidates(FROM, "./y")!.slice(0, 3)).toEqual([
      `${P}/a/web/internal/y`,
      `${P}/a/web/internal/y.tsx`,
      `${P}/a/web/internal/y.jsx`,
    ]);
  });

  it("is null for a package or a file not in the set", () => {
    expect(resolveSpecifier(FROM, "react", has)).toBeNull();
    expect(resolveSpecifier(FROM, "./gone", has)).toBeNull();
  });
});
