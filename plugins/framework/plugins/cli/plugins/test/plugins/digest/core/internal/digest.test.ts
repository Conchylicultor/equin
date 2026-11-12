import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  createMemoryRecordStore,
  gitBlobId,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { testDigests } from "./digest";

// A fixture repo's plugins directory: paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";

// The file-facts scan, as a checkout holds it: every graph keys its facts by
// this module's Merkle key, so a fixture set carries the real one.
const SCAN_PATH =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const SCAN = readFileSync(join(REPO_ROOT, SCAN_PATH), "utf8");

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

const BUN_A = `${P}/a/core/a.test.ts`;
const BUN_B = `${P}/b/core/b.test.ts`;
const DOM = `${P}/a/web/__tests__/v.test.ts`;
const BASE: Record<string, string> = {
  "bunfig.toml": "[test]\n",
  "test/bun-preload.ts":
    'import "./preload-dep";\nawait import("./dynamic-only");\n',
  "test/preload-dep.ts": "export const p = 1;\n",
  "test/dynamic-only.ts": "export const d = 1;\n",
  "vitest.config.ts": "export default {};\n",
  "test/setup.ts": "export {};\n",
  [BUN_A]: 'import { x } from "./dep";\n',
  [`${P}/a/core/dep.ts`]: "export const x = 1;\n",
  [BUN_B]: "export {};\n",
  [`${P}/b/core/other.ts`]: "export const y = 1;\n",
  [DOM]: "export {};\n",
};
const FILES = [BUN_A, BUN_B, DOM];

async function digestsOf(
  edit: Record<string, string> = {},
): Promise<Record<string, string>> {
  const d = await testDigests(
    snapshotOf({ ...BASE, ...edit }),
    createMemoryRecordStore(),
    FILES,
  );
  return Object.fromEntries([...d].map(([f, v]) => [f, v.digest]));
}

describe("testDigests", () => {
  test("the same content in two snapshots digests the same, runners from the split", async () => {
    const store = createMemoryRecordStore();
    const one = await testDigests(snapshotOf(BASE), store, FILES);
    const two = await testDigests(snapshotOf({ ...BASE }), store, FILES);
    expect([...one]).toEqual([...two]);
    expect(one.get(BUN_A)!.runner).toBe("bun:test");
    expect(one.get(DOM)!.runner).toBe("vitest");
  });

  test("a dependency edit moves only the files that import it", async () => {
    const before = await digestsOf();
    const after = await digestsOf({
      [`${P}/a/core/dep.ts`]: "export const x = 2;\n",
    });
    expect(after[BUN_A]).not.toBe(before[BUN_A]);
    expect(after[BUN_B]).toBe(before[BUN_B]);
    expect(after[DOM]).toBe(before[DOM]);
  });

  test("an unrelated edit moves nothing", async () => {
    const before = await digestsOf();
    const after = await digestsOf({
      [`${P}/b/core/other.ts`]: "export const y = 2;\n",
    });
    expect(after).toEqual(before);
  });

  test("bunfig.toml and the preload's static closure move only bun digests", async () => {
    const before = await digestsOf();
    const edits: Record<string, string>[] = [
      { "bunfig.toml": "[test]\npreload = []\n" },
      { "test/preload-dep.ts": "export const p = 2;\n" },
    ];
    for (const edit of edits) {
      const after = await digestsOf(edit);
      expect(after[BUN_A]).not.toBe(before[BUN_A]);
      expect(after[BUN_B]).not.toBe(before[BUN_B]);
      expect(after[DOM]).toBe(before[DOM]);
    }
  });

  test("a module the preload loads only dynamically moves nothing", async () => {
    const before = await digestsOf();
    const after = await digestsOf({
      "test/dynamic-only.ts": "export const d = 2;\n",
    });
    expect(after).toEqual(before);
  });

  test("the vitest setup file moves only vitest digests", async () => {
    const before = await digestsOf();
    const after = await digestsOf({ "test/setup.ts": "export const s = 1;\n" });
    expect(after[DOM]).not.toBe(before[DOM]);
    expect(after[BUN_A]).toBe(before[BUN_A]);
  });
});
