import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeGlobalCssKey,
  parseCssImports,
  unionCandidates,
} from "./global-css";
import { tailwindCandidatesOf } from "./tailwind-candidates";
import { cachedAggregateHash } from "./own-files";
import type { FingerprintCache } from "./store";

describe("parseCssImports", () => {
  test("extracts @import specifiers, ignoring @source", () => {
    const css = [
      `@import "tailwindcss" source(none);`,
      `@import "shadcn/tailwind.css";`,
      `@import '@fontsource-variable/inter';`,
      `@source "../../../../plugins/";`,
      `@custom-variant dark (&:is(.dark *));`,
    ].join("\n");
    expect(parseCssImports(css)).toEqual([
      "tailwindcss",
      "shadcn/tailwind.css",
      "@fontsource-variable/inter",
    ]);
  });
});

describe("unionCandidates", () => {
  test("merges, dedupes and sorts every artifact's candidates", () => {
    expect(
      unionCandidates(
        [
          { tailwindCandidates: ["p-md", "flex"] },
          { tailwindCandidates: [] },
          { tailwindCandidates: ["flex", "bg-card"] },
        ],
        (i) => `a${i}`,
      ),
    ).toEqual(["bg-card", "flex", "p-md"]);
  });

  test("throws, naming the artifact, on a meta that records none", () => {
    expect(() =>
      unionCandidates([{ tailwindCandidates: ["x"] }, {}], (i) => `a${i}`),
    ).toThrow(/a1 records no tailwindCandidates/);
  });
});

describe("computeGlobalCssKey", () => {
  const pluginsRoot = join(import.meta.dir, "../../../../../../..");
  const key = (candidates: string[]) =>
    computeGlobalCssKey({ pluginsRoot, minify: true, candidates });

  test("follows the candidate union, and only it", () => {
    expect(key(["flex", "p-md"])).toBe(key(["flex", "p-md"]));
    expect(key(["flex", "p-md", "p-lg"])).not.toBe(key(["flex", "p-md"]));
  });
});

describe("tailwindCandidatesOf", () => {
  test("extracts a file's classes; a comment-only edit adds only the comment's words", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-candidates-test-"));
    const file = join(dir, "one.tsx");
    writeFileSync(
      file,
      `export const A = () => <div className="p-md bg-card" />;\n`,
    );
    const before = await tailwindCandidatesOf([file]);
    expect(before).toContain("p-md");
    expect(before).toContain("bg-card");
    writeFileSync(
      file,
      `export const A = () => <div className="p-md bg-card" />;\n// x\n`,
    );
    expect(await tailwindCandidatesOf([file])).toEqual(
      [...new Set([...before, "x"])].sort(),
    );
    writeFileSync(
      file,
      `export const A = () => <div className="p-md bg-card text-lg" />;\n`,
    );
    expect(await tailwindCandidatesOf([file])).toContain("text-lg");
  });

  test("reads only the files it is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-candidates-test-"));
    writeFileSync(join(dir, "a.tsx"), `<i className="rounded-sm" />`);
    writeFileSync(join(dir, "b.tsx"), `<i className="rounded-lg" />`);
    const got = await tailwindCandidatesOf([join(dir, "a.tsx")]);
    expect(got).toContain("rounded-sm");
    expect(got).not.toContain("rounded-lg");
  });

  test("throws on a file name a scanner source cannot spell", async () => {
    expect(tailwindCandidatesOf(["/x/[id].tsx"])).rejects.toThrow(
      /glob metacharacter/,
    );
  });
});

describe("cachedAggregateHash (the own-files content fingerprint)", () => {
  const freshCache = (): FingerprintCache => ({ version: 1, records: {} });

  function fixture(): { dir: string; files: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "css-key-test-"));
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "one.tsx"), `<div className="p-md" />`);
    writeFileSync(join(dir, "b.md"), "docs");
    return {
      dir,
      files: [join(dir, "a", "one.tsx"), join(dir, "b.md")].sort(),
    };
  }

  test("content change flips the hash; untouched sibling set keeps it", async () => {
    const { dir, files } = fixture();
    const h1 = await cachedAggregateHash({
      cacheKey: "k",
      baseDir: dir,
      files,
      cache: freshCache(),
    });
    const h1again = await cachedAggregateHash({
      cacheKey: "k",
      baseDir: dir,
      files,
      cache: freshCache(),
    });
    expect(h1again).toBe(h1);

    writeFileSync(join(dir, "a", "one.tsx"), `<div className="p-lg" />`);
    const h2 = await cachedAggregateHash({
      cacheKey: "k",
      baseDir: dir,
      files,
      cache: freshCache(),
    });
    expect(h2).not.toBe(h1);
  });

  test("stat fast path reuses the recorded hash without re-reading", async () => {
    const { dir, files } = fixture();
    const cache = freshCache();
    const h1 = await cachedAggregateHash({
      cacheKey: "k",
      baseDir: dir,
      files,
      cache,
    });
    // Poison the recorded hash: an (incorrect) sentinel proves the fast path
    // returns the RECORD, i.e. no content was re-read when stats match.
    cache.records["k"]!.ownHash = "sentinel";
    expect(
      await cachedAggregateHash({ cacheKey: "k", baseDir: dir, files, cache }),
    ).toBe("sentinel");

    // An mtime bump invalidates the record and recomputes the true hash.
    const later = new Date(Date.now() + 5000);
    utimesSync(files[0]!, later, later);
    expect(
      await cachedAggregateHash({ cacheKey: "k", baseDir: dir, files, cache }),
    ).toBe(h1);
  });

  test("a vanished file changes the set (and never throws)", async () => {
    const { dir, files } = fixture();
    const h1 = await cachedAggregateHash({
      cacheKey: "k",
      baseDir: dir,
      files,
      cache: freshCache(),
    });
    const withGhost = [...files, join(dir, "gone.ts")];
    const h2 = await cachedAggregateHash({
      cacheKey: "k",
      baseDir: dir,
      files: withGhost,
      cache: freshCache(),
    });
    expect(h2).toBe(h1); // ENOENT contributes nothing — same effective set
  });
});
