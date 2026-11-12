import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { scanFilesCached, type FileScan } from "./file-scans";
import { gitBlobId } from "./keys";
import { NO_OUTSIDE_FILES } from "./module-graph";
import { createMemoryRecordStore, type RecordStore } from "./store";

// A file record is keyed by the scan module's whole closure, the file's path
// and bytes, and the scan's params — and by nothing else. So a scan sees a
// change to any module it runs, and not one to a module it does not.

// A fixture repo's plugins directory: its paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";

const SCAN_IMPORTS =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const SCAN_IMPORTS_SRC = readFileSync(
  join(import.meta.dir, "scan-imports.ts"),
  "utf8",
);

const SCAN_MODULE = `${P}/s/core/words.scan.ts`;
const base: Record<string, string> = {
  [SCAN_MODULE]:
    'import { split } from "@plugins/leaf/core";\nexport const words = split;',
  [`${P}/leaf/core/index.ts`]: 'export { split } from "./split";',
  [`${P}/leaf/core/split.ts`]:
    "export const split = (s: string) => s.split(' ');",
  // Beside the scan's closure: the leaf's sibling, never imported by it.
  [`${P}/leaf-sibling/core/index.ts`]: "export const glyphs = ['a'];",
  "docs/a.md": "one two",
  "docs/b.md": "three",
};

function snapshotOf(files: Record<string, string>): RepoSnapshot {
  const all: Record<string, string> = {
    ...files,
    [SCAN_IMPORTS]: SCAN_IMPORTS_SRC,
  };
  const paths = Object.keys(all).sort();
  return {
    root: asAppPath("/repo"),
    all: () => paths,
    has: (p) => p in all,
    under: (dir) => paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: () => {
      throw new Error("unused");
    },
    read: (p) => Promise.resolve(all[p] ?? null),
    blobOf: (p) => {
      const c = all[p];
      if (c === undefined) throw new Error(`not a member: ${p}`);
      return gitBlobId(c);
    },
  };
}

/** Scan `files` of `fixture` into `store`; how many files were scanned (missed). */
async function misses(
  store: RecordStore,
  fixture: Record<string, string>,
  params?: readonly string[],
): Promise<number> {
  let scanned = 0;
  const scan: FileScan<string[]> = {
    url: `file:///checkout/${SCAN_MODULE}`,
    ...(params ? { params } : {}),
    scan: (src) => {
      scanned++;
      return src.split(" ");
    },
  };
  await scanFilesCached(
    { snapshot: snapshotOf(fixture), store, readOutside: NO_OUTSIDE_FILES },
    ["docs/a.md", "docs/b.md"],
    scan,
  );
  return scanned;
}

describe("file record keys", () => {
  test("a second pass over the same set scans nothing", async () => {
    const store = createMemoryRecordStore();
    expect(await misses(store, base)).toBe(2);
    expect(await misses(store, base)).toBe(0);
  });

  test("an edit to a module the scan runs rescans every file", async () => {
    const store = createMemoryRecordStore();
    await misses(store, base);
    const edited = {
      ...base,
      [`${P}/leaf/core/split.ts`]:
        "export const split = (s: string) => s.split('\\n');",
    };
    expect(await misses(store, edited)).toBe(2);
  });

  test("an edit beside the scan's closure rescans nothing", async () => {
    const store = createMemoryRecordStore();
    await misses(store, base);
    const edited = {
      ...base,
      [`${P}/leaf-sibling/core/index.ts`]: "export const glyphs = ['a', 'b'];",
    };
    expect(await misses(store, edited)).toBe(0);
  });

  test("an edit to one file rescans that file alone", async () => {
    const store = createMemoryRecordStore();
    await misses(store, base);
    expect(await misses(store, { ...base, "docs/b.md": "four five" })).toBe(1);
  });

  test("each param list keeps its own record of every file", async () => {
    const store = createMemoryRecordStore();
    await misses(store, base, ["x"]);
    expect(await misses(store, base, ["y"])).toBe(2);
    expect(await misses(store, base, ["x"])).toBe(0);
  });
});

describe("the npm code in a file record's key", () => {
  // The shape bun writes, trimmed: `eslint` depends on `acorn`; `zod` is
  // installed beside them; `acorn` is patched.
  const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "repo" },
  },
  "patchedDependencies": {
    "acorn@8.0.0": "patches/acorn@8.0.0.patch",
  },
  "packages": {
    "acorn": ["acorn@8.0.0", "", {}, "sha512-a"],
    "eslint": ["eslint@9.0.0", "", { "dependencies": { "acorn": "^8" } }, "sha512-e"],
    "zod": ["zod@4.0.0", "", {}, "sha512-z"],
  }
}
`;
  const PATCH = "--- a/index.js\n+++ b/index.js\n";
  const withLock = (
    files: Record<string, string>,
    lock = LOCK,
    patch = PATCH,
  ): Record<string, string> => ({
    ...files,
    "bun.lock": lock,
    "patches/acorn@8.0.0.patch": patch,
  });
  // The scan's leaf loads eslint (and so acorn), and a builtin.
  const loadsEslint = withLock({
    ...base,
    [`${P}/leaf/core/split.ts`]:
      'import { Linter } from "eslint/universal";\nimport { readFile } from "node:fs";\nexport const split = (s: string) => s.split(" ");',
  });

  test("a scan that loads no package is moved by no lockfile change", async () => {
    const store = createMemoryRecordStore();
    await misses(store, withLock(base));
    const bumped = withLock(base, LOCK.replace("eslint@9.0.0", "eslint@9.0.1"));
    expect(await misses(store, bumped)).toBe(0);
  });

  test("a bump of a package the scan never loads rescans nothing", async () => {
    const store = createMemoryRecordStore();
    await misses(store, loadsEslint);
    const bumped = {
      ...loadsEslint,
      "bun.lock": LOCK.replace("zod@4.0.0", "zod@4.0.1"),
    };
    expect(await misses(store, bumped)).toBe(0);
  });

  test("a bump of a package the scan loads, or of its dependency, rescans every file", async () => {
    const store = createMemoryRecordStore();
    await misses(store, loadsEslint);
    expect(
      await misses(store, {
        ...loadsEslint,
        "bun.lock": LOCK.replace("eslint@9.0.0", "eslint@9.0.1"),
      }),
    ).toBe(2);
    expect(
      await misses(store, {
        ...loadsEslint,
        "bun.lock": LOCK.replace('"sha512-a"', '"sha512-a2"'),
      }),
    ).toBe(2);
  });

  test("an edit to a patch the scan's packages carry rescans every file", async () => {
    const store = createMemoryRecordStore();
    await misses(store, loadsEslint);
    expect(
      await misses(store, {
        ...loadsEslint,
        "patches/acorn@8.0.0.patch": `${PATCH}@@ -1 +1 @@\n-a\n+b\n`,
      }),
    ).toBe(2);
  });
});
