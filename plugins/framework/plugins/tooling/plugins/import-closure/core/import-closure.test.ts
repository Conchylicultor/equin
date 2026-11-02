/**
 * `importClosures` over the real repo: one build over several entrypoints
 * answers exactly the union of each one's `importClosure`, and a module's
 * chain is the one the first entrypoint reaching it answers, and its
 * `children` are the build's own edges.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { importClosure, importClosures } from "./import-closure";

setDefaultTimeout(120_000);

// Two entrypoints whose closures overlap (both reach `plugin-id/core`), the
// second also reached BY the first — the case where "first entrypoint
// reaching it" decides the chain.
const ENTRIES = [
  "plugins/framework/plugins/tooling/plugins/import-closure/core/index.ts",
  "plugins/framework/plugins/cli/core/index.ts",
  "plugins/framework/plugins/plugin-id/core/index.ts",
];

describe("importClosures", () => {
  test("is the union of each entrypoint's closure, with the first reacher's chains", async () => {
    const root = await getWorktreeRoot();
    const policy = { dynamicImports: "cut" } as const;
    const singles = [];
    for (const e of ENTRIES) singles.push(await importClosure(root, e, policy));
    const union = await importClosures(root, ENTRIES, policy);

    const expected = new Set(singles.flatMap((c) => [...c.modules]));
    expect([...union.modules].sort()).toEqual([...expected].sort());
    for (const module of expected) {
      const first = singles.find((c) => c.modules.has(module))!;
      expect(union.importChain(module)).toEqual(first.importChain(module));
    }
  });

  test("children are the build's edges: in the closure, and every chain walks them", async () => {
    const root = await getWorktreeRoot();
    const union = await importClosures(root, ENTRIES, {
      dynamicImports: "cut",
    });
    for (const module of union.modules) {
      for (const child of union.children(module)) {
        expect(union.modules.has(child)).toBe(true);
      }
      const chain = union.importChain(module);
      for (let i = 1; i < chain.length; i++) {
        expect(union.children(chain[i - 1]!)).toContain(chain[i]!);
      }
    }
    expect(union.children(ENTRIES[0]!)).toContain(
      "plugins/framework/plugins/tooling/plugins/import-closure/core/import-closure.ts",
    );
    expect(() => union.children("nowhere/never-loaded.ts")).toThrow(
      "the bundler never loaded it",
    );
  });

  test("throws for a module no entrypoint reaches, and for no entrypoint", async () => {
    const root = await getWorktreeRoot();
    const union = await importClosures(root, ENTRIES.slice(2), {
      dynamicImports: "cut",
    });
    expect(() => union.importChain(ENTRIES[0]!)).toThrow(
      "it is not in this closure at all",
    );
    let message = "";
    try {
      await importClosures(root, [], { dynamicImports: "cut" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("handed no entrypoint");
  });
});
