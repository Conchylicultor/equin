/**
 * Import resolution and the reach over a file set: resolution asks the set
 * (never the disk), directories resolve to their `index.ts`, and each reached
 * file is read exactly once however many roots and importers reach it.
 */

import { test, expect } from "bun:test";
import {
  globPaths,
  type RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { collectImportGraph, resolveImportSpecifier } from "./import-graph";

// Fixture paths go through `pj(rel)` rather than bare `plugins/<seg>/…`
// literals — the repo's own `plugin-refs-resolve` check validates that every
// such literal in source resolves to a real plugin, and these are synthetic.
const pj = (rel: string): string => `plugins/${rel}`;

function memRepo(
  root: string,
  files: Record<string, string>,
): RepoFiles & { reads: string[] } {
  const paths = Object.keys(files).sort();
  const reads: string[] = [];
  return {
    root,
    reads,
    all: () => paths,
    // As the run's file set does: a malformed path is a caller bug, not a miss.
    has: (p) => {
      if (
        p === "" ||
        p.startsWith("/") ||
        p.split("/").some((s) => s === ".." || s === ".")
      )
        throw new Error(`malformed repo path: ${p}`);
      return Object.hasOwn(files, p);
    },
    under: (dir) =>
      dir === "" ? paths : paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: (pattern) => globPaths(paths, pattern),
    read: (p) => {
      reads.push(p);
      return Promise.resolve(Object.hasOwn(files, p) ? files[p]! : null);
    },
  };
}

const R = "/repo";

test("resolution tries the spec, .ts, .tsx, then index.ts — against the file set", () => {
  const repo = memRepo(R, {
    [pj("a/web/x.ts")]: "",
    [pj("a/web/y.tsx")]: "",
    [pj("a/web/dir/index.ts")]: "",
    [pj("a/web/data.json")]: "",
    [pj("b/core/index.ts")]: "",
  });
  const from = `${R}/plugins/a/web/index.ts`;
  expect(resolveImportSpecifier(repo, from, "./x")).toBe(
    `${R}/plugins/a/web/x.ts`,
  );
  expect(resolveImportSpecifier(repo, from, "./y")).toBe(
    `${R}/plugins/a/web/y.tsx`,
  );
  expect(resolveImportSpecifier(repo, from, "./dir")).toBe(
    `${R}/plugins/a/web/dir/index.ts`,
  );
  expect(resolveImportSpecifier(repo, from, "./data.json")).toBe(
    `${R}/plugins/a/web/data.json`,
  );
  expect(resolveImportSpecifier(repo, from, "@plugins/b/core")).toBe(
    `${R}/plugins/b/core/index.ts`,
  );
  expect(resolveImportSpecifier(repo, from, "./missing")).toBeNull();
  expect(resolveImportSpecifier(repo, from, "../../../../outside")).toBeNull();
});

test("the reach follows runtime imports only, and reads each file once", async () => {
  const repo = memRepo(R, {
    [pj("a/web/index.ts")]: [
      'import { x } from "./x";',
      'import type { T } from "./typeonly";',
      'import "./reg.generated";',
      'import "./style.css";',
      'import React from "react";',
    ].join("\n"),
    [pj("a/server/index.ts")]: 'export * from "../web/x";',
    [pj("a/web/x.ts")]: 'import "./reg.generated";\nexport const x = 1;',
    [pj("a/web/typeonly.ts")]: "export type T = 1;",
    [pj("a/web/reg.generated.ts")]: "export const r = [];",
  });
  const web = `${R}/plugins/a/web/index.ts`;
  const server = `${R}/plugins/a/server/index.ts`;
  const graph = await collectImportGraph(repo, [web, server, web]);

  expect(graph.get(web)).toEqual([
    `${R}/plugins/a/web/x.ts`,
    `${R}/plugins/a/web/reg.generated.ts`,
  ]);
  expect(graph.get(server)).toEqual([`${R}/plugins/a/web/x.ts`]);
  expect(graph.has(`${R}/plugins/a/web/typeonly.ts`)).toBe(false);
  expect(repo.reads.sort()).toEqual(
    [
      pj("a/server/index.ts"),
      pj("a/web/index.ts"),
      pj("a/web/reg.generated.ts"),
      pj("a/web/x.ts"),
    ].sort(),
  );
});
