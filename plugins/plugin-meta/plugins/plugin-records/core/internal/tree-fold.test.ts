import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { gitBlobId } from "./keys";
import { NO_OUTSIDE_FILES } from "./module-graph";
import { createMemoryRecordStore, type RecordStore } from "./store";
import { foldFilesCached, type FileFold, type FoldLimits } from "./tree-fold";

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

/** Counts the fold's lookups (keys asked of its table) and what it writes there. */
function counting(store: RecordStore): RecordStore & {
  asked: () => number;
  written: () => [string, string][];
} {
  let asked = 0;
  const written: [string, string][] = [];
  return {
    ...store,
    environment: store.environment,
    getMany: (table, keys) => {
      if (table === "fold") asked += keys.length;
      return store.getMany(table, keys);
    },
    putMany: (t, e) => {
      if (t === "fold")
        written.push(...e.map(([k, v]) => [k, v] as [string, string]));
      return store.putMany(t, e);
    },
    flush: () => store.flush(),
    asked: () => asked,
    written: () => written,
  };
}

/** What a pass adds to the store: keys it did not hold, and the bytes of their values. */
async function added(
  store: RecordStore & { written: () => [string, string][] },
  pass: () => Promise<unknown>,
): Promise<{ keys: number; bytes: number; values: string[] }> {
  const from = store.written().length;
  await pass();
  const entries = store.written().slice(from);
  const held = await store.getMany(
    "fold",
    entries.map(([k]) => k),
  );
  // The memory store keeps the first value of a key; every entry is new
  // unless an earlier pass of this test wrote it.
  const earlier = new Set(
    store
      .written()
      .slice(0, from)
      .map(([k]) => k),
  );
  const values = entries
    .filter(([k]) => !earlier.has(k) && held.has(k))
    .map(([, v]) => v);
  return {
    keys: values.length,
    bytes: values.reduce((n, v) => n + v.length, 0),
    values,
  };
}

async function run(
  store: RecordStore,
  files: Record<string, string>,
  context: { sep: string } = { sep: "+" },
  limits?: FoldLimits,
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
    limits,
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

  test("an unchanged tree is one lookup, its value one more, and no scan", async () => {
    const store = counting(createMemoryRecordStore());
    const files = fixture();
    const first = await run(store, files);
    const before = store.asked();
    const again = await run(store, files);
    expect(again.value).toBe(first.value);
    expect(again.scanned).toEqual([]);
    // The root's node record, then the value it names (held whole).
    expect(store.asked() - before).toBe(2);
  });

  test("an edit scans the edited file and asks only along its path", async () => {
    const store = counting(createMemoryRecordStore());
    const files = fixture();
    await run(store, files);
    const before = store.asked();
    const edited = { ...files, "src/b/y/f3.txt": "EDIT" };
    const { value, scanned } = await run(store, edited);
    expect(scanned).toEqual(["src/b/y/f3.txt"]);
    // Node records — src (the root holds only src/, so it is src),
    // src/{a,b,c}, src/b/{w,x,y,z}, src/b/y/f0..f4 — then the values the
    // re-folded directories combine: their 4 + 3 + 2 unchanged members.
    expect(store.asked() - before).toBe(1 + 3 + 4 + 5 + (4 + 3 + 2));
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

  test("a one-member directory is its member, with no record of its own", async () => {
    const store = createMemoryRecordStore();
    const written: string[] = [];
    const recording: RecordStore = {
      ...store,
      environment: store.environment,
      getMany: (t, k) => store.getMany(t, k),
      putMany: (t, e) => {
        if (t === "fold") written.push(...e.map(([k]) => k));
        return store.putMany(t, e);
      },
      flush: () => store.flush(),
    };
    const files = { [FOLD_MODULE]: "x", "src/only/deep/f.txt": "F" };
    const { value } = await run(recording, files);
    expect(value).toBe("F+");
    // The root, src/, src/only/ and src/only/deep/ all fold to the one file:
    // its node record and its value.
    expect(written.length).toBe(2);
    const one = await run(createMemoryRecordStore(), { [FOLD_MODULE]: "x" });
    expect(one.value).toBe("");
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

  // Held as lists of refs: every directory above 40 characters of answer.
  const SMALL: FoldLimits = { inlineLimit: 40 };

  test("a directory too large to hold whole is a list, and folds to the flat answer", async () => {
    const files = fixture();
    const flat = (await run(createMemoryRecordStore(), files)).value;
    const store = counting(createMemoryRecordStore());
    const cold = await run(store, files, undefined, SMALL);
    expect(cold.value).toBe(flat);
    const lists = store.written().filter(([, v]) => v.startsWith("+"));
    // src and src/{a,b,c} (5 files of 5 characters each per leaf directory:
    // 25 characters, held whole).
    expect(lists.length).toBe(4);
    const warm = await run(store, files, undefined, SMALL);
    expect(warm.value).toBe(flat);
    expect(warm.scanned).toEqual([]);
  });

  test("an edit writes its own path, never the whole answer", async () => {
    const files = fixture();
    const store = counting(createMemoryRecordStore());
    await run(store, files, undefined, SMALL);
    const total = store.written().reduce((n, [, v]) => n + v.length, 0);
    const edited = { ...files, "src/b/y/f3.txt": "EDIT" };
    let value = "";
    const write = await added(store, async () => {
      value = (await run(store, edited, undefined, SMALL)).value;
    });
    expect(value).toBe((await run(createMemoryRecordStore(), edited)).value);
    // Node records of f3, src/b/y, src/b, src; values of f3, src/b/y (whole),
    // and the lists src/b and src.
    expect(write.keys).toBe(4 + 4);
    expect(write.bytes).toBeLessThan(total / 3);
  });

  test("an edit that leaves its file's part as it was writes no value", async () => {
    const files = fixture();
    const store = counting(createMemoryRecordStore());
    const fold: FileFold<{ sep: string }, string> = {
      url: `file:///checkout/${FOLD_MODULE}`,
      // The part ignores everything after a `#`: a comment.
      scan: (src) => src.split("#")[0]!,
      combine: (parts) => parts.join(""),
    };
    const selected = (f: Record<string, string>) =>
      Object.keys(f).filter((p) => p.startsWith("src/"));
    const pass = (f: Record<string, string>) =>
      foldFilesCached(
        { snapshot: snapshotOf(f), store, readOutside: NO_OUTSIDE_FILES },
        selected(f),
        fold,
        { sep: "" },
        SMALL,
      );
    const first = await pass(files);
    const edited = {
      ...files,
      "src/b/y/f3.txt": `${files["src/b/y/f3.txt"]}#note`,
    };
    let value = "";
    const write = await added(store, async () => {
      value = await pass(edited);
    });
    expect(value).toBe(first);
    // Only the node records along the edited path: f3, src/b/y, src/b, src —
    // each naming the value it named before.
    expect(write.keys).toBe(4);
    for (const ref of write.values) expect(ref).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  test("a value the store no longer holds is folded again, costing its own subtree", async () => {
    const files = fixture();
    const inner = counting(createMemoryRecordStore());
    await run(inner, files, undefined, SMALL);
    // Reclaim f0's value: its node record stays, naming it. No warm pass
    // reads it (src/b/y is held whole), so only an edit beside it notices.
    const f0 = files["src/b/y/f0.txt"]!;
    const gone = new Set(
      inner
        .written()
        .filter(([, v]) => v === `=${JSON.stringify(`${f0}+`)}`)
        .map(([k]) => k),
    );
    expect(gone.size).toBe(1);
    const reclaimed: RecordStore = {
      ...inner,
      environment: inner.environment,
      getMany: async (t, keys) => {
        const got = await inner.getMany(t, keys);
        for (const k of gone) got.delete(k);
        return got;
      },
      putMany: (t, e) => {
        for (const [k] of e) gone.delete(k);
        inner.putMany(t, e);
      },
      flush: () => inner.flush(),
    };
    const edited = { ...files, "src/b/y/f3.txt": "EDIT" };
    const { value, scanned } = await run(reclaimed, edited, undefined, SMALL);
    expect(value).toBe((await run(createMemoryRecordStore(), edited)).value);
    expect(scanned.sort()).toEqual(["src/b/y/f0.txt", "src/b/y/f3.txt"]);
    expect(gone.size).toBe(0);
  });

  test("with every value reclaimed, the node records still lead to the right answer", async () => {
    const files = fixture();
    const inner = counting(createMemoryRecordStore());
    await run(inner, files, undefined, SMALL);
    const gone = new Set(
      inner
        .written()
        .filter(([, v]) => v.startsWith("=") || v.startsWith("+"))
        .map(([k]) => k),
    );
    const reclaimed: RecordStore = {
      ...inner,
      environment: inner.environment,
      getMany: async (t, keys) => {
        const got = await inner.getMany(t, keys);
        for (const k of gone) got.delete(k);
        return got;
      },
      putMany: (t, e) => {
        for (const [k] of e) gone.delete(k);
        inner.putMany(t, e);
      },
      flush: () => inner.flush(),
    };
    const { value } = await run(reclaimed, files, undefined, SMALL);
    expect(value).toBe((await run(createMemoryRecordStore(), files)).value);
    expect(gone.size).toBe(0);
  });
});
