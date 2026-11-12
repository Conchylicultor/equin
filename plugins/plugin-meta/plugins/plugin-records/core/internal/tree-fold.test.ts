import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { gitBlobId } from "./keys";
import { NO_OUTSIDE_FILES } from "./module-graph";
import { createMemoryRecordStore, type RecordStore } from "./store";
import { foldFilesCached, type FileFold } from "./tree-fold";

// A fold is a Merkle tree of records over the selected files: an edit costs
// its own path from the root (the lookups) and its own files (the scans).

const P = "plugins";
const SCAN_IMPORTS =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const SCAN_IMPORTS_SRC = readFileSync(
  join(import.meta.dir, "scan-imports.ts"),
  "utf8",
);
const FOLD_MODULE = `${P}/s/core/words.scan.ts`;

/** 3 top directories × 4 subdirectories × 5 files, each holding its own path. */
function fixture(): Record<string, string> {
  const files: Record<string, string> = {
    [FOLD_MODULE]: "export const words = 1;",
  };
  for (const a of ["a", "b", "c"])
    for (const b of ["w", "x", "y", "z"])
      for (let i = 0; i < 5; i++)
        files[`src/${a}/${b}/f${i}.txt`] = `${a}${b}${i}`;
  return files;
}

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

/** Counts the fold's lookups (keys asked of its table). */
function counting(store: RecordStore): RecordStore & { asked: () => number } {
  let asked = 0;
  return {
    ...store,
    environment: store.environment,
    getMany: (table, keys) => {
      if (table === "fold") asked += keys.length;
      return store.getMany(table, keys);
    },
    putMany: (t, e) => store.putMany(t, e),
    flush: () => store.flush(),
    asked: () => asked,
  };
}

async function run(
  store: RecordStore,
  files: Record<string, string>,
  context: { sep: string } = { sep: "+" },
): Promise<{ value: string; scanned: string[] }> {
  const scanned: string[] = [];
  const fold: FileFold<{ sep: string }, string> = {
    url: `file:///checkout/${FOLD_MODULE}`,
    scan: (src, rel, ctx) => {
      scanned.push(rel);
      return `${src}${ctx.sep}`;
    },
    combine: (parts) => parts.join(""),
  };
  const selected = Object.keys(files).filter((p) => p.startsWith("src/"));
  const value = await foldFilesCached(
    { snapshot: snapshotOf(files), store, readOutside: NO_OUTSIDE_FILES },
    selected,
    fold,
    context,
  );
  return { value, scanned };
}

describe("foldFilesCached", () => {
  test("folds to the flat answer, in path order", async () => {
    const files = fixture();
    const flat = Object.keys(files)
      .filter((p) => p.startsWith("src/"))
      .sort()
      .map((p) => `${files[p]}+`)
      .join("");
    const { value, scanned } = await run(createMemoryRecordStore(), files);
    expect(value).toBe(flat);
    expect(scanned.length).toBe(60);
  });

  test("an unchanged tree is one lookup and no scan", async () => {
    const store = counting(createMemoryRecordStore());
    const files = fixture();
    const first = await run(store, files);
    const before = store.asked();
    const again = await run(store, files);
    expect(again.value).toBe(first.value);
    expect(again.scanned).toEqual([]);
    expect(store.asked() - before).toBe(1);
  });

  test("an edit scans the edited file and asks only along its path", async () => {
    const store = counting(createMemoryRecordStore());
    const files = fixture();
    await run(store, files);
    const before = store.asked();
    const edited = { ...files, "src/b/y/f3.txt": "EDIT" };
    const { value, scanned } = await run(store, edited);
    expect(scanned).toEqual(["src/b/y/f3.txt"]);
    // root, src, src/{a,b,c}, src/b/{w,x,y,z}, src/b/y/f0..f4
    expect(store.asked() - before).toBe(1 + 1 + 3 + 4 + 5);
    expect(value).toBe((await run(createMemoryRecordStore(), edited)).value);
  });

  test("a changed context refolds every file", async () => {
    const store = createMemoryRecordStore();
    const files = fixture();
    await run(store, files);
    const { scanned, value } = await run(store, files, { sep: "-" });
    expect(scanned.length).toBe(60);
    expect(value.includes("-")).toBe(true);
  });

  test("an added file is folded in, the rest stays recorded", async () => {
    const store = createMemoryRecordStore();
    const files = fixture();
    await run(store, files);
    const added = { ...files, "src/c/new/n.txt": "N" };
    const { scanned, value } = await run(store, added);
    expect(scanned).toEqual(["src/c/new/n.txt"]);
    expect(value).toBe((await run(createMemoryRecordStore(), added)).value);
  });
});
