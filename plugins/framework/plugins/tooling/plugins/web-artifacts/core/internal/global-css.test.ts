import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  computeGlobalCssKey,
  parseCssImports,
  unionCandidates,
} from "./global-css";
import { tailwindCandidatesOf } from "./tailwind-candidates";

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
  const pluginsRoot = joinAppPath(REPO_ROOT, "plugins");
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
