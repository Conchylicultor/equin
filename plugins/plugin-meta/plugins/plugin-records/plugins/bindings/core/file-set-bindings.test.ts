import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { gitBlobId } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { fileSetBindings } from "./file-set-bindings";

// A fixture repo's plugins directory: its paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";

// The module graph's file-facts scan, as a checkout holds it: every graph
// keys its facts by this module's Merkle key, so a fixture set carries it.
const SCAN_PATH =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const SCAN = readFileSync(
  join(import.meta.dir, "../../../core/internal/scan-imports.ts"),
  "utf8",
);

function snapshotOf(fixture: Record<string, string>): RepoSnapshot {
  const files: Record<string, string> = { ...fixture, [SCAN_PATH]: SCAN };
  const paths = Object.keys(files).sort();
  return {
    root: asAppPath("/repo"),
    all: () => paths,
    has: (p) => p in files,
    under: (dir) => paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: () => {
      throw new Error("unused");
    },
    read: (p) => Promise.resolve(files[p] ?? null),
    blobOf: (p) => {
      const c = files[p];
      if (c === undefined) throw new Error(`not a member: ${p}`);
      return gitBlobId(c);
    },
  };
}

// The bindings scan, as a checkout holds it: its records are keyed by its
// module's closure (parse-utils' core), so a fixture set carries the real one.
const PARSE_UTILS = "plugins/plugin-meta/plugins/parse-utils/core";
const BINDINGS_FILES: Record<string, string> = Object.fromEntries([
  [
    "plugins/plugin-meta/plugins/plugin-records/plugins/bindings/core/bindings.scan.ts",
    readFileSync(join(import.meta.dir, "bindings.scan.ts"), "utf8"),
  ],
  ...[
    "index",
    "endpoint-exports",
    "find-imports",
    "find-marker-calls",
    "helpers",
    "host-services",
    "mask-source",
    "server-contribution-kinds",
    "snapshot-scope",
  ].map((f) => [
    `${PARSE_UTILS}/${f}.ts`,
    readFileSync(
      join(import.meta.dir, `../../../../parse-utils/core/${f}.ts`),
      "utf8",
    ),
  ]),
]);

describe("fileSetBindings", () => {
  test("each edge the graph resolves, with the names its statements bind", async () => {
    const snap = snapshotOf({
      ...BINDINGS_FILES,
      [`${P}/a/core/x.ts`]: [
        'import { b, c as d } from "@plugins/b/core";',
        'export { e } from "@plugins/b/core";',
        'import { type T } from "./types";',
        'import * as ns from "./ns";',
        'const lazy = () => import("./lazy");',
        'const req = require("./req");',
        'import ts from "typescript";',
        "export const x = [b, d, ns, lazy, req, ts];",
      ].join("\n"),
      [`${P}/a/core/types.ts`]: "export type T = 1;",
      [`${P}/a/core/ns.ts`]: "export const n = 1;",
      [`${P}/a/core/lazy.ts`]: "export const l = 1;",
      [`${P}/a/core/req.ts`]: "export const r = 1;",
      [`${P}/b/core/index.ts`]: [
        'export { b, c } from "./bc";',
        'export * as e from "./e";',
        'export type { T } from "./t";',
        "export type U = 1;",
      ].join("\n"),
      [`${P}/b/core/bc.ts`]: "export const b = 1, c = 2;",
      [`${P}/b/core/e.ts`]: "export const e = 1;",
      [`${P}/b/core/t.ts`]: "export type T = 1;",
    });
    const out = await fileSetBindings(snap, [
      `${P}/a/core/x.ts`,
      `${P}/b/core/index.ts`,
      `${P}/b/core/bc.ts`,
    ]);
    const x = out.get(`${P}/a/core/x.ts`)!;
    // An all-`type` binding list is erased: no edge to ./types.
    expect(
      x.imports
        .map((i) => [i.target, i.names])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      [`${P}/a/core/lazy.ts`, "all"],
      [`${P}/a/core/ns.ts`, "all"],
      [`${P}/a/core/req.ts`, "all"],
      [`${P}/b/core/index.ts`, ["b", "c", "e"]],
      [`${P}/b/core/index.ts`, ["b", "c", "e"]],
    ]);
    expect(x.reexports).toBeNull();
    expect(x.packages).toContain("typescript");
    expect(out.get(`${P}/b/core/index.ts`)!.reexports).toEqual([
      {
        target: `${P}/b/core/bc.ts`,
        exports: [
          ["b", "b"],
          ["c", "c"],
        ],
      },
      { target: `${P}/b/core/e.ts`, exports: [["e", null]] },
    ]);
    // A module with code of its own is no pure re-export module.
    expect(out.get(`${P}/b/core/bc.ts`)!.reexports).toBeNull();
  });

  test("an import that resolves to no file of the set throws", () => {
    const snap = snapshotOf({
      ...BINDINGS_FILES,
      [`${P}/a/core/x.ts`]: 'import { m } from "./missing";\nexport { m };',
    });
    expect(fileSetBindings(snap, [`${P}/a/core/x.ts`])).rejects.toThrow(
      "resolves to no file of the checkout",
    );
  });
});
