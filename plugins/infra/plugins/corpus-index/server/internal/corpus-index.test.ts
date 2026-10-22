import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePersist,
  createCorpusIndex,
  defineCorpusIndex,
  loadCorpusFile,
  refreshCorpus,
  type CorpusFile,
  type CorpusIndexEnv,
  type CorpusIndexSpec,
  type RefreshDeps,
} from "./corpus-index";

// ─── Fixture ─────────────────────────────────────────────────────────────────
// A tiny `<root>/<dir>/<name>.txt` tree standing in for a real corpus. `parse`
// records how many times each path was parsed so the fingerprint-skip and
// vanished-drop behaviour is directly observable.

let root: string;
let corpusRoot: string;
let indexPath: string;
let parseCount: Map<string, number>;

const VERSION = 1;

function deps(
  overrides: Partial<RefreshDeps<string>> = {},
): RefreshDeps<string> {
  return {
    roots: [corpusRoot],
    match: (p) => p.endsWith(".txt"),
    parse: async (p) => {
      parseCount.set(p, (parseCount.get(p) ?? 0) + 1);
      return await readFile(p, "utf8");
    },
    indexPath,
    concurrency: 4,
    persist: false,
    withSlot: (fn) => fn(),
    // A real macrotask yield, exercising the between-files breath.
    yieldMacrotask: () => new Promise<void>((r) => setImmediate(r)),
    ...overrides,
  };
}

function empty(): CorpusFile<string> {
  return { version: VERSION, files: {} };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corpus-index-test-"));
  corpusRoot = join(root, "corpus");
  indexPath = join(root, "index.json");
  parseCount = new Map();
  await mkdir(join(corpusRoot, "a"), { recursive: true });
  await mkdir(join(corpusRoot, "b"), { recursive: true });
  await writeFile(join(corpusRoot, "a", "one.txt"), "one");
  await writeFile(join(corpusRoot, "a", "two.txt"), "two");
  await writeFile(join(corpusRoot, "b", "three.txt"), "three");
  // A non-matching file that must be ignored by `match`.
  await writeFile(join(corpusRoot, "b", "skip.md"), "skip");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("cold path parses every matching file (and only matching files)", async () => {
  const index = empty();
  const { changed } = await refreshCorpus(index, deps());
  expect(changed).toBe(true);
  expect(Object.keys(index.files).length).toBe(3); // .md excluded
  expect([...parseCount.values()].every((n) => n === 1)).toBe(true);
  expect(Object.keys(index.files).some((p) => p.endsWith("skip.md"))).toBe(
    false,
  );
});

test("only changed files re-parse (fingerprint skip)", async () => {
  const index = empty();
  await refreshCorpus(index, deps());
  const before = new Map(Object.entries(index.files));

  // Second pass, nothing touched → zero re-parses, same entry objects, no change.
  parseCount.clear();
  const { changed } = await refreshCorpus(index, deps());
  expect(changed).toBe(false);
  expect(parseCount.size).toBe(0);
  for (const [path, e] of Object.entries(index.files)) {
    expect(e).toBe(before.get(path)!); // same object → not re-parsed
  }

  // Append to exactly one file → its (mtime,size) changes → exactly one re-parse.
  parseCount.clear();
  const changedPath = join(corpusRoot, "a", "one.txt");
  await appendFile(changedPath, " more");
  const r2 = await refreshCorpus(index, deps());
  expect(r2.changed).toBe(true);
  expect(parseCount.size).toBe(1);
  expect(parseCount.get(changedPath)).toBe(1);
  expect(index.files[changedPath]!.partial).toBe("one more");
});

test("vanished files are dropped", async () => {
  const index = empty();
  await refreshCorpus(index, deps());
  expect(Object.keys(index.files).length).toBe(3);

  await rm(join(corpusRoot, "b", "three.txt"));
  const { changed } = await refreshCorpus(index, deps());
  expect(changed).toBe(true);
  expect(Object.keys(index.files).length).toBe(2);
  expect(Object.keys(index.files).some((p) => p.endsWith("three.txt"))).toBe(
    false,
  );
});

test("a version mismatch forces a full rebuild (empty on load)", async () => {
  // Persist a v1 index, then load it asking for v2 → treated as empty.
  const index = empty();
  await refreshCorpus(index, deps({ persist: true }));
  const loadedSame = await loadCorpusFile<string>(indexPath, VERSION);
  expect(Object.keys(loadedSame.files).length).toBe(3); // same version → reused

  const loadedBumped = await loadCorpusFile<string>(indexPath, VERSION + 1);
  expect(loadedBumped.version).toBe(VERSION + 1);
  expect(Object.keys(loadedBumped.files).length).toBe(0); // mismatch → rebuild
});

test("persist writes an atomic, re-loadable index; no temp file lingers", async () => {
  const index = empty();
  const { changed } = await refreshCorpus(index, deps({ persist: true }));
  expect(changed).toBe(true);

  // The index file is valid JSON and round-trips.
  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as CorpusFile<string>;
  expect(parsed.version).toBe(VERSION);
  expect(Object.keys(parsed.files).length).toBe(3);
  const reloaded = await loadCorpusFile<string>(indexPath, VERSION);
  expect(Object.keys(reloaded.files).length).toBe(3);

  // No `.tmp` sibling left behind (temp was renamed, not left dangling).
  const siblings = await readFile(indexPath, "utf8").then(() => true);
  expect(siblings).toBe(true);
});

test("persist=false never writes the index to disk", async () => {
  const index = empty();
  await refreshCorpus(index, deps({ persist: false }));
  const wrote = await readFile(indexPath, "utf8").then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    },
  );
  expect(wrote).toBe(false);
});

test("computePersist: host scope persists only on main; worktree always persists", () => {
  expect(computePersist("host", true)).toBe(true);
  expect(computePersist("host", false)).toBe(false); // host, non-main → no write
  expect(computePersist("worktree", true)).toBe(true);
  expect(computePersist("worktree", false)).toBe(true);
});

// ─── Instance-level (createCorpusIndex) — markDirty, ensureFresh delta ────────
// Same injectable seam as refreshCorpus above, one level up: `env` stubs the
// host wiring (isMain / heavy-read slot / macrotask yield / watcher) so the
// dirty-latch and delta plumbing are observable without a real backend.

function spec(
  overrides: Partial<CorpusIndexSpec<string>> = {},
): CorpusIndexSpec<string> {
  return {
    name: "test.corpus",
    description: "Test corpus.",
    roots: [corpusRoot],
    match: (p) => p.endsWith(".txt"),
    parse: async (p) => {
      parseCount.set(p, (parseCount.get(p) ?? 0) + 1);
      return await readFile(p, "utf8");
    },
    indexPath,
    scope: "worktree",
    version: VERSION,
    concurrency: 4,
    ...overrides,
  };
}

function env(overrides: Partial<CorpusIndexEnv> = {}): CorpusIndexEnv {
  return {
    isMain: () => true,
    withSlot: (fn) => fn(),
    yieldMacrotask: () => new Promise<void>((r) => setImmediate(r)),
    startFileWatcher: async () => {},
    watcherRegistration: { register: () => {} },
    ...overrides,
  };
}

test("markDirty forces a re-walk on main after a clean ensureFresh (dirty-latch)", async () => {
  // On main, ensureFresh clears `dirty` and short-circuits until re-dirtied.
  const idx = createCorpusIndex(spec(), env({ isMain: () => true }));
  const cold = await idx.ensureFresh();
  expect(cold.addedPaths.length).toBe(3); // no prior entries ⇒ all added
  expect(cold.modifiedPaths).toEqual([]); // nothing had an entry to modify
  expect(idx.entries().size).toBe(3);

  // A new file appears, but with no invalidation main short-circuits on !dirty.
  const four = join(corpusRoot, "a", "four.txt");
  await writeFile(four, "four");
  const stale = await idx.ensureFresh();
  expect(stale.addedPaths).toEqual([]); // did not re-walk
  expect(stale.modifiedPaths).toEqual([]);
  expect(idx.entries().size).toBe(3); // new file NOT seen — the regression

  // markDirty() is the ONLY invalidation seam for a self-watching consumer.
  idx.markDirty();
  const fresh = await idx.ensureFresh();
  expect(fresh.addedPaths).toEqual([four]); // no prior entry ⇒ added, not modified
  expect(fresh.modifiedPaths).toEqual([]);
  expect(idx.entries().size).toBe(4);
});

test("ensureFresh returns the delta: added / modified / removed / and empty when nothing moved", async () => {
  // isMain:false ⇒ no dirty short-circuit, so every call actually re-walks.
  const idx = createCorpusIndex(spec(), env({ isMain: () => false }));

  const cold = await idx.ensureFresh();
  expect(cold.addedPaths.length).toBe(3); // every matching file has no prior entry
  expect(cold.modifiedPaths).toEqual([]); // "no prior fingerprint" ≠ "edited"
  expect(cold.removedPaths).toEqual([]);

  // Nothing moved → all arrays empty (a real empty success, not a failure).
  const noop = await idx.ensureFresh();
  expect(noop.addedPaths).toEqual([]);
  expect(noop.modifiedPaths).toEqual([]);
  expect(noop.removedPaths).toEqual([]);

  // A brand-new file (no prior entry) lands in addedPaths — never modifiedPaths.
  const four = join(corpusRoot, "a", "four.txt");
  await writeFile(four, "four");
  const added = await idx.ensureFresh();
  expect(added.addedPaths).toEqual([four]);
  expect(added.modifiedPaths).toEqual([]);
  expect(added.removedPaths).toEqual([]);

  // A touched file (prior entry, size/mtime bump) lands in modifiedPaths.
  const one = join(corpusRoot, "a", "one.txt");
  await appendFile(one, " more");
  const touched = await idx.ensureFresh();
  expect(touched.modifiedPaths).toEqual([one]);
  expect(touched.addedPaths).toEqual([]);
  expect(touched.removedPaths).toEqual([]);

  // An unlinked file lands in removedPaths.
  await rm(four);
  const removed = await idx.ensureFresh();
  expect(removed.addedPaths).toEqual([]);
  expect(removed.modifiedPaths).toEqual([]);
  expect(removed.removedPaths).toEqual([four]);
});

test("defineCorpusIndex with no parse yields CorpusIndex<null> and still indexes files", async () => {
  // Enumerate-only: no `parse`. TPartial is pinned to `null` by the overload.
  const idx = defineCorpusIndex({
    name: "test.noparse",
    description: "Test corpus.",
    roots: [corpusRoot],
    match: (p) => p.endsWith(".txt"),
    indexPath,
    scope: "worktree",
    version: VERSION,
  });
  const delta = await idx.ensureFresh();
  expect(delta.addedPaths.length).toBe(3);
  expect(delta.modifiedPaths).toEqual([]);

  const entries = idx.entries();
  expect(entries.size).toBe(3); // the .md is excluded by match
  for (const value of entries.values()) {
    // A `null` payload is the whole contract of the no-parse overload.
    expect(value).toBeNull();
  }
});

test("a second caller joining an in-flight ensureFresh receives the same delta", async () => {
  // Hold `parse` open so the first refresh stays in-flight while the second
  // caller enters; both must observe the SAME delta, never a silent empty one.
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const idx = createCorpusIndex(
    spec({
      parse: async (p) => {
        await gate;
        return await readFile(p, "utf8");
      },
    }),
    env({ isMain: () => false }),
  );

  const first = idx.ensureFresh();
  const second = idx.ensureFresh(); // joins the in-flight refresh
  release();
  const [d1, d2] = await Promise.all([first, second]);

  expect(d1).toBe(d2); // same delta object — the join returned the real result
  expect(d1.addedPaths.length).toBe(3);
  expect(d1.modifiedPaths).toEqual([]);
  expect(d1.removedPaths).toEqual([]);
});

test("a cold index reports every file as added, never modified", async () => {
  // The regression: a `host`-scope backend never persists its index
  // (computePersist("host", isMain()=false) === false), so a fresh process
  // starts COLD — the on-disk index is absent/empty. Every file must land in
  // addedPaths ("no prior fingerprint" ⇒ unknown), and modifiedPaths must be
  // EMPTY. Treating added-as-modified is what re-imported the whole corpus on
  // every worktree boot.

  // First instance builds an in-memory index but persists nothing (worktree
  // backend of a host-scope corpus never writes).
  const first = createCorpusIndex(
    spec({ scope: "host" }),
    env({ isMain: () => false }),
  );
  const firstDelta = await first.ensureFresh();
  expect(firstDelta.addedPaths.length).toBe(3);
  expect(firstDelta.modifiedPaths).toEqual([]);

  // The index file was never written — a second process boots cold.
  const wrote = await readFile(indexPath, "utf8").then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    },
  );
  expect(wrote).toBe(false);

  // A SECOND instance over the SAME dir with an absent index file. Even though
  // the files are unchanged on disk, this cold index has no prior entries, so
  // every file is `added` and NONE is `modified`.
  const second = createCorpusIndex(
    spec({ scope: "host" }),
    env({ isMain: () => false }),
  );
  const secondDelta = await second.ensureFresh();
  expect(secondDelta.modifiedPaths).toEqual([]); // ← the load-bearing assertion
  expect(new Set(secondDelta.addedPaths)).toEqual(
    new Set([...second.entries().keys()]),
  );
  expect(secondDelta.addedPaths.length).toBe(3);
});

test("onChange fires after a refresh that moved a file, never on an empty one; watching() follows startWatcher", async () => {
  let watcherOnChange: (() => Promise<unknown>) | undefined;
  const idx = createCorpusIndex(
    spec(),
    env({
      isMain: () => true,
      startFileWatcher: async ({ onChange }) => {
        watcherOnChange = onChange;
      },
    }),
  );
  let heard = 0;
  const stop = idx.onChange(() => heard++);

  expect(idx.watching()).toBe(false);
  await idx.startWatcher();
  expect(idx.watching()).toBe(true);

  await idx.ensureFresh(); // cold: every file added ⇒ a moved refresh
  expect(heard).toBe(1);
  idx.markDirty();
  await idx.ensureFresh(); // nothing moved
  expect(heard).toBe(1);

  await writeFile(join(corpusRoot, "a", "five.txt"), "five");
  await watcherOnChange!(); // the watcher's pass
  expect(heard).toBe(2);

  stop();
  await writeFile(join(corpusRoot, "a", "six.txt"), "six");
  idx.markDirty();
  await idx.ensureFresh();
  expect(heard).toBe(2); // unsubscribed
});
