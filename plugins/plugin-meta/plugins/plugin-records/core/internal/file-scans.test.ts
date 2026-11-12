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
