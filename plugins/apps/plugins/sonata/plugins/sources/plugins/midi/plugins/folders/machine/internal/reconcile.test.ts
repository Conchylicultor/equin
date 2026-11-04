import { expect, test } from "bun:test";
import { sep } from "node:path";
import { reconcileWith, type ReconcileDeps } from "./reconcile";
import type { CorpusDelta } from "@plugins/infra/plugins/corpus-index/server";

// ─── Fixture ─────────────────────────────────────────────────────────────────
// A recording harness over the injectable ReconcileDeps seam: on-disk files are
// the corpus `entries()` keys, DB rows are `listImported()`, and every enqueue /
// setSourceMissing / listImported call is counted so the decision logic (which
// paths import, the single query, reverse drift) is directly observable — no
// filesystem, no database.

interface Song {
  songId: string;
  sourcePath: string;
  sourceMissing: boolean;
}

interface Harness {
  deps: ReconcileDeps;
  enqueued: string[];
  missingSet: Array<{ songId: string; missing: boolean }>;
  listImportedCalls: number;
}

function harness(opts: {
  onDisk: string[];
  added?: string[];
  modified?: string[];
  removed?: string[];
  songs?: Song[];
  watchedDirs: string[];
}): Harness {
  const enqueued: string[] = [];
  const missingSet: Array<{ songId: string; missing: boolean }> = [];
  const state = { listImportedCalls: 0 };
  const songs = opts.songs ?? [];
  const delta: CorpusDelta = {
    addedPaths: opts.added ?? [],
    modifiedPaths: opts.modified ?? [],
    removedPaths: opts.removed ?? [],
  };

  const deps: ReconcileDeps = {
    markDirty: () => {},
    ensureFresh: () => Promise.resolve(delta),
    entries: () => new Map(opts.onDisk.map((p) => [p, null])),
    watchedDirs: () => opts.watchedDirs,
    listImported: () => {
      state.listImportedCalls += 1;
      return Promise.resolve(songs);
    },
    enqueueImport: (p) => {
      enqueued.push(p);
      return Promise.resolve();
    },
    setSourceMissing: (songId, missing) => {
      missingSet.push({ songId, missing });
      return Promise.resolve();
    },
  };

  return {
    deps,
    enqueued,
    missingSet,
    get listImportedCalls() {
      return state.listImportedCalls;
    },
  };
}

const DIR = `${sep}music`;
const p = (name: string) => `${DIR}${sep}${name}`;

// ─── Tests ───────────────────────────────────────────────────────────────────

test("calls listFolderImportedSongs exactly once for N on-disk files (N+1 kill)", async () => {
  const h = harness({
    onDisk: [p("a.mid"), p("b.mid"), p("c.mid"), p("d.mid"), p("e.mid")],
    songs: [],
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(h.listImportedCalls).toBe(1);
});

test("enqueues a brand-new on-disk file with no song row", async () => {
  const h = harness({
    onDisk: [p("new.mid")],
    songs: [],
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(h.enqueued).toEqual([p("new.mid")]);
});

test("enqueues an imported file whose song is flagged sourceMissing (file came back)", async () => {
  const h = harness({
    onDisk: [p("back.mid")],
    songs: [{ songId: "s1", sourcePath: p("back.mid"), sourceMissing: true }],
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(h.enqueued).toEqual([p("back.mid")]);
});

test("enqueues a file whose fingerprint changed while the backend was down", async () => {
  const h = harness({
    onDisk: [p("edited.mid")],
    modified: [p("edited.mid")],
    songs: [{ songId: "s1", sourcePath: p("edited.mid"), sourceMissing: false }],
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(h.enqueued).toEqual([p("edited.mid")]);
});

test("does NOT enqueue an unchanged, already-imported file", async () => {
  const h = harness({
    onDisk: [p("stable.mid")],
    modified: [],
    songs: [{ songId: "s1", sourcePath: p("stable.mid"), sourceMissing: false }],
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(h.enqueued).toEqual([]);
});

test("a cold index (every file added) does NOT re-import already-imported songs", async () => {
  // The 19-file re-import regression: this corpus index is `scope: "host"`, so a
  // worktree backend never persists it and boots COLD — every file surfaces in
  // `addedPaths`. Reconcile must treat `addedPaths` as UNKNOWN, not CHANGED: the
  // DB (a non-missing song row) is the authority on what is already imported.
  // Against the old `changedPaths` logic this enqueued all 5; it must now be [].
  const files = [p("a.mid"), p("b.mid"), p("c.mid"), p("d.mid"), p("e.mid")];
  const h = harness({
    onDisk: files,
    added: files, // cold index: every file has no prior fingerprint
    modified: [],
    songs: files.map((sourcePath, i) => ({
      songId: `s${i}`,
      sourcePath,
      sourceMissing: false,
    })),
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(h.enqueued).toEqual([]);
  expect(h.missingSet).toEqual([]);
});

test("reverse drift: marks missing a song whose file is gone but path still under a watched dir", async () => {
  const h = harness({
    onDisk: [],
    songs: [{ songId: "s1", sourcePath: p("gone.mid"), sourceMissing: false }],
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(h.missingSet).toEqual([{ songId: "s1", missing: true }]);
});

test("reverse drift: leaves a song under a no-longer-watched dir untouched", async () => {
  const h = harness({
    onDisk: [],
    songs: [
      { songId: "s1", sourcePath: `${sep}old${sep}gone.mid`, sourceMissing: false },
    ],
    watchedDirs: [DIR], // /music — the song is under /old, no longer watched
  });
  await reconcileWith(h.deps);
  expect(h.missingSet).toEqual([]);
});

test("reverse drift: does not re-mark an already-missing song", async () => {
  const h = harness({
    onDisk: [],
    songs: [{ songId: "s1", sourcePath: p("gone.mid"), sourceMissing: true }],
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(h.missingSet).toEqual([]);
});

test("mixed corpus: new + missing + changed enqueue; stable does not; vanished marks missing", async () => {
  const h = harness({
    onDisk: [p("new.mid"), p("back.mid"), p("edited.mid"), p("stable.mid")],
    modified: [p("edited.mid")],
    songs: [
      { songId: "back", sourcePath: p("back.mid"), sourceMissing: true },
      { songId: "edited", sourcePath: p("edited.mid"), sourceMissing: false },
      { songId: "stable", sourcePath: p("stable.mid"), sourceMissing: false },
      { songId: "vanished", sourcePath: p("vanished.mid"), sourceMissing: false },
    ],
    watchedDirs: [DIR],
  });
  await reconcileWith(h.deps);
  expect(new Set(h.enqueued)).toEqual(
    new Set([p("new.mid"), p("back.mid"), p("edited.mid")]),
  );
  expect(h.enqueued).not.toContain(p("stable.mid"));
  expect(h.missingSet).toEqual([{ songId: "vanished", missing: true }]);
  expect(h.listImportedCalls).toBe(1);
});
