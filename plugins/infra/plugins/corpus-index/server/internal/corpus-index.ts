import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import {
  defineFileWatcher,
  journalChangesSince,
  journalCursor,
  type JournalCursor,
  type JournalCursorResult,
  type JournalReplay,
} from "@plugins/infra/plugins/file-watcher/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import type { SourceSet } from "@plugins/packages/plugins/source-digest/core";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";
import type { CorpusFormat } from "../../core";
import { createCheckpointStore } from "./checkpoints";
import { createLineReader, readFileRange, type FileStamp } from "./line-reader";
import {
  loadCorpusFile,
  recordCorpusChanges,
  saveCorpusSnapshot,
  type CorpusFile,
} from "./store";

// ─── What this is ─────────────────────────────────────────────────────────────
//
// A fingerprint-keyed incremental file index — the generalization of the
// `stats/cost` usage-index template. A corpus is a set of files under some
// roots matching a predicate; each file is parsed exactly once (keyed on its
// `(mtimeMs, size)` fingerprint) and its per-file `TPartial` cached on disk.
// Only changed/new files are re-parsed; vanished files are dropped. The parse
// pipeline is bounded (concurrency + host-wide heavy-read slot + a macrotask
// yield between files) so a cold rebuild never freezes the serving loop.
//
// The ROLLUP of the per-file partials into whatever the consumer serves stays
// in the consumer (this primitive owns only the incremental index mechanics).

/** Caller-facing declaration of a corpus index. */
export interface CorpusIndexSpec<TPartial> {
  /** Stable id → warmup name / profiler span (only used by {@link CorpusIndex.warmup}). */
  name: string;
  /**
   * What this index holds and why, in one present-tense sentence a user reads
   * (e.g. "Indexes agent transcripts so usage stats load without rescanning
   * every file."). Forwarded to the warm-up it declares.
   */
  description: string;
  /** Roots to enumerate. A function so callers can defer path resolution. */
  roots: string[] | (() => string[]);
  /**
   * Which files belong and what each becomes — `corpusFormat(import.meta,
   * { match, parse | lines })` (this plugin's core), declared in a small
   * module. The stored index is stamped with that module's code digest: an
   * index built by another `match` / reading is rebuilt. The reading is
   * side-effect-free (data only, never persists): `parse` reads a changed file
   * whole, `lines` folds only what was appended since the last read; neither
   * ⇒ enumerate-only (every partial `null`).
   */
  format: CorpusFormat<TPartial>;
  /** On-disk index file path (host-global dir or a per-worktree data dir). */
  indexPath: string;
  /**
   * `host` ⇒ a single shared index; only main PERSISTS it (`isMain()` gate) so
   * worktree backends read it and compute any delta in-memory without racing on
   * the write. `worktree` ⇒ each backend owns its index and always persists.
   */
  scope: "host" | "worktree";
  /** Bounded readdir/stat/parse concurrency (defaults to {@link DEFAULT_CONCURRENCY}). */
  concurrency?: number;
  /**
   * Who hears the corpus change. `index` (the default): the index's own
   * main-only watch ({@link CorpusIndex.startWatcher}); off main, every
   * refresh walks. `consumer`: the consumer already watches the roots on every
   * backend and reports each batch's paths through
   * {@link CorpusIndex.markChanged} — a refresh then re-checks only those, on
   * every backend, and the index opens no watch of its own.
   */
  watchedBy?: "index" | "consumer";
}

/**
 * The paths that moved during a refresh. An all-empty delta means nothing moved
 * — a legitimate empty success, NOT an absorbed failure (a refresh that fails
 * throws).
 *
 * `added` and `modified` are deliberately SEPARATE, and conflating them is a
 * bug: a path is `added` when the index held no entry for it, which on a cold
 * index — the first walk of a process, or any `host`-scope backend that never
 * persists (`computePersist`) — is EVERY file. "No prior fingerprint" means
 * *unknown*, not *edited*. Only `modified` (a prior entry existed and its
 * `(mtimeMs,size)` differs) proves the bytes changed since the last walk, so
 * only `modified` may drive "re-do the work for this file". A consumer deciding
 * whether a file is new should ask its OWN store, not `addedPaths`.
 */
export interface CorpusDelta {
  /** No prior index entry. On a cold index this is every file ⇒ means "unknown". */
  addedPaths: string[];
  /** Had an entry, fingerprint differs ⇒ genuinely edited since the last walk. */
  modifiedPaths: string[];
  /** Had an entry, file is gone ⇒ dropped from the index. */
  removedPaths: string[];
}

export interface CorpusIndex<TPartial> {
  /**
   * Lazy `(mtimeMs,size)` stat-diff refresh — THE correctness fallback. Call on
   * every read: it makes warmup deferral safe (a cold first request just pays
   * the incremental stat-diff, re-parsing only what changed). Single-flighted;
   * a second caller joining an in-flight refresh receives that refresh's delta.
   * Returns the {@link CorpusDelta} of files that moved (all arrays empty when
   * nothing changed, including the main-only clean short-circuit).
   */
  ensureFresh(): Promise<CorpusDelta>;
  /** The current per-file partials, keyed by path. The rollup stays in the consumer. */
  entries(): Map<string, TPartial>;
  /**
   * Force the next {@link ensureFresh} to re-walk every root, even where a
   * watch keeps it fresh — the answer to a watch that reported dropped events.
   * A consumer whose own watch heard every change reports it through
   * {@link markChanged} instead: a walk is O(corpus).
   */
  markDirty(): void;
  /**
   * For an index declared `watchedBy: "consumer"` (throws otherwise): the
   * paths a batch of the consumer's own watch named. The next
   * {@link ensureFresh} re-checks only those (on every backend), never a walk.
   */
  markChanged(paths: Iterable<string>): void;
  /**
   * For an index declared `watchedBy: "consumer"` (throws otherwise): the
   * consumer's watch of `root` just opened — whatever moved under it before
   * went unheard, so the next {@link ensureFresh} catches that root up from
   * the journal (walking it when the journal cannot vouch).
   */
  markWatchOpened(root: string): void;
  /**
   * Main-only push freshness via `@parcel/watcher`: a change batch marks the
   * paths it named stale and re-checks THOSE in the background (never a full
   * walk); a dropped-events report from the watch (`onLost`) re-walks
   * everything. No-op off main / if already started.
   * Requires {@link watcher} to be mounted in the calling plugin's `register`
   * (on main it throws otherwise).
   */
  startWatcher(): Promise<void>;
  /**
   * Whether this process's {@link startWatcher} watch is open (main, after the
   * warm-up started it). A consumer that needs to hear corpus changes asks
   * this first: while it is true, {@link onChange} is a complete change signal
   * and opening a second watch of the same roots would only duplicate it.
   */
  watching(): boolean;
  /**
   * Hear every refresh that moved a file — any {@link ensureFresh} whose delta
   * is non-empty, the watcher's (each change it hears) or a read's. Called
   * synchronously after the pass: a listener must be cheap (enqueue its work)
   * and must not throw. A complete signal of corpus changes only while
   * {@link watching} is true; off it, nothing re-walks until a read does.
   * Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void;
  /**
   * The index's declared file watcher (`corpus-index.<name>`, main-only),
   * opened by {@link startWatcher}. Mount it in `register: [...]` next to the
   * warm-up that calls `startWatcher()` — {@link warmup} does not include it.
   * An index that never calls `startWatcher()` (it owns its own watcher and
   * uses `markDirty()`) leaves it unmounted.
   */
  watcher: Registration;
  /**
   * Convenience: a `defineWarmup({ scope, run: startWatcher + ensureFresh })`
   * Registration (mount {@link watcher} with it). Consumers with EXTRA warm
   * work (e.g. pricing) should instead write their own `defineWarmup` that
   * calls `ensureFresh`/`startWatcher`.
   */
  warmup(): Registration;
}

// How many files a `lines` format holds a fold state for in memory (least
// recently read evicted): the files being appended to now — main's live
// transcripts and their sub-agents' — not the corpus (4.7k transcripts on
// main, whose states held at once would be every message hash ever written).
// An evicted file's next read continues from its on-disk checkpoint, like a
// new process's first one: a state's load plus the bytes folded since it.
const HELD_LINE_STATES = 64;

// Bounded parse concurrency: caps resident memory to ~K files' text at once
// (killing the unbounded-Promise.all spike) while still admitting each read
// through the host-wide heavy-read gate.
const DEFAULT_CONCURRENCY = 6;

// ─── persist mapping (host ⇒ main-only) ───────────────────────────────────────

/**
 * The single-writer invariant: a `host` index is persisted only by main; a
 * `worktree` index is always persisted by its own backend. Exported for tests.
 */
export function computePersist(
  scope: "host" | "worktree",
  mainBackend: boolean,
): boolean {
  return scope === "host" ? mainBackend : true;
}

// ─── enumerate ──────────────────────────────────────────────────────────────────

/**
 * Collect every file under `roots` for which `match` is true, recursing into
 * subdirectories. ENOENT at any level is tolerated (a root or dir that vanished
 * mid-walk contributes nothing). Symlinks are not followed (only `isDirectory()`
 * entries are recursed) so the walk cannot loop. The result is in depth-first
 * dirent order, as a serial walk would list it.
 *
 * Directories are listed `concurrency` at a time, never one by one: each
 * `readdir` is a thread-pool round-trip that does almost no work, so a serial
 * walk is bound by the round-trips, not the listing. Walking `~/Downloads`
 * (26k dirs, 112k entries) for Sonata's MIDI folders took 6–9 s serially —
 * every main boot — and ~0.45 s with 8 in flight, for the same CPU. The gate
 * wraps the `readdir` alone, never a subtree, so a directory waiting on its
 * children holds no slot.
 */
export async function enumerate(
  roots: string[],
  match: (path: string) => boolean,
  concurrency: number,
): Promise<string[]> {
  const gate = createSemaphore(concurrency);
  const walk = async (dir: string): Promise<string[]> => {
    let dirents;
    try {
      dirents = await gate.run(() => readdir(dir, { withFileTypes: true }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return [];
    }
    const found = await Promise.all(
      dirents.map(async (d): Promise<string[]> => {
        const full = join(dir, d.name);
        if (d.isDirectory()) return await walk(full);
        return match(full) ? [full] : [];
      }),
    );
    return found.flat();
  };
  return (await Promise.all(roots.map(walk))).flat();
}

// ─── refresh (incremental) ──────────────────────────────────────────────────────

/** Injectable dependencies for {@link refreshCorpus} — the testability seam. */
export interface RefreshDeps<TPartial> {
  roots: string[];
  match: (path: string) => boolean;
  /**
   * A changed file's partial; `file` is the pass's own stat of it (the size
   * and inode the partial is read up to, and keyed on).
   */
  read: (path: string, file: FileStamp) => Promise<TPartial>;
  indexPath: string;
  concurrency: number;
  /** Whether to persist the index after a change (see {@link computePersist}). */
  persist: boolean;
  withSlot: <R>(fn: () => Promise<R>) => Promise<R>;
  yieldMacrotask: () => Promise<void>;
}

/** What one refresh pass did: {@link CorpusDelta} plus whether anything moved. */
export interface RefreshResult extends CorpusDelta {
  changed: boolean;
}

/**
 * Incremental refresh: enumerate `deps.roots`, `stat` every file, re-parse only
 * those whose `(mtimeMs,size)` fingerprint changed (or are new), drop entries
 * under those roots for files that vanished. Mutates `index` in place; persists (once) if a change
 * occurred and `deps.persist` is set.
 */
export async function refreshCorpus<TPartial>(
  index: CorpusFile<TPartial>,
  deps: RefreshDeps<TPartial>,
): Promise<RefreshResult> {
  const paths = await enumerate(deps.roots, deps.match, deps.concurrency);
  const live = new Set(paths);
  const delta: CorpusDelta = {
    addedPaths: [],
    modifiedPaths: [],
    removedPaths: [],
  };

  // Drop entries for files that no longer exist — under the roots walked. An
  // entry under another root (one not walked by this pass, or one out of the
  // root set for now) keeps it: that root is caught up from its own cursor.
  for (const path of Object.keys(index.files)) {
    if (!live.has(path) && deps.roots.some((r) => isUnder(path, r))) {
      delete index.files[path];
      delta.removedPaths.push(path);
    }
  }

  return await reindexFiles(index, paths, deps, delta);
}

/**
 * Targeted refresh: re-check ONLY `changedPaths` — what a file watcher said
 * moved — instead of walking the corpus. A path that is gone drops its entry
 * (and, for a removed directory, every entry under it); a directory that
 * appeared is enumerated (a folder moved in may surface as one event); a file
 * goes through the same fingerprint gate as a full pass. Paths outside the
 * roots, or not matching, are ignored. The full walk ({@link refreshCorpus})
 * stays the cold pass and the answer to a dropped-events report.
 */
export async function refreshCorpusPaths<TPartial>(
  index: CorpusFile<TPartial>,
  changedPaths: Iterable<string>,
  deps: RefreshDeps<TPartial>,
): Promise<RefreshResult> {
  const delta: CorpusDelta = {
    addedPaths: [],
    modifiedPaths: [],
    removedPaths: [],
  };
  const underRoot = (p: string): boolean =>
    deps.roots.some((r) => p === r || p.startsWith(`${r}/`));
  const files = new Set<string>();
  for (const path of changedPaths) {
    if (!underRoot(path)) continue;
    let st;
    try {
      st = await stat(path);
    } catch (err) {
      // ENOTDIR: a directory above it became a file — the path is gone too.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      // Gone: the file itself, or a directory and everything under it.
      const prefix = `${path}/`;
      for (const known of Object.keys(index.files)) {
        if (known === path || known.startsWith(prefix)) {
          delete index.files[known];
          delta.removedPaths.push(known);
        }
      }
      continue;
    }
    if (st.isDirectory()) {
      for (const p of await enumerate([path], deps.match, deps.concurrency))
        files.add(p);
    } else if (deps.match(path)) {
      files.add(path);
    }
  }
  return await reindexFiles(index, [...files], deps, delta);
}

/**
 * The fingerprint gate both passes share: stat each path, re-parse the ones
 * whose `(mtimeMs,size)` moved (or that are new), drop one that vanished since
 * it was listed; then persist once if anything moved.
 */
async function reindexFiles<TPartial>(
  index: CorpusFile<TPartial>,
  paths: readonly string[],
  deps: RefreshDeps<TPartial>,
  delta: CorpusDelta,
): Promise<RefreshResult> {
  const { addedPaths, modifiedPaths, removedPaths } = delta;
  // Stat all files; collect the ones whose fingerprint changed (or are new).
  // `hadEntry` distinguishes the two, and the distinction is load-bearing for
  // consumers (see the CorpusDelta doc): a file with NO prior entry is only
  // "added" — on a cold index (first walk of a process, or a `host`-scope
  // backend that never persists) that is EVERY file, which means "unknown",
  // not "edited". Only a file that HAD an entry with a different fingerprint
  // is genuinely "modified since the last walk".
  const toParse: Array<{
    path: string;
    mtimeMs: number;
    size: number;
    ino: number;
    hadEntry: boolean;
  }> = [];
  const statGate = createSemaphore(deps.concurrency);
  await Promise.all(
    paths.map((path) =>
      statGate.run(async () => {
        let st;
        try {
          st = await stat(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          // Vanished since it was listed (or named by the watcher).
          if (index.files[path] !== undefined) {
            delete index.files[path];
            removedPaths.push(path);
          }
          return;
        }
        const cached = index.files[path];
        if (
          cached &&
          cached.mtimeMs === st.mtimeMs &&
          cached.size === st.size
        ) {
          return; // unchanged file — skip
        }
        toParse.push({
          path,
          mtimeMs: st.mtimeMs,
          size: st.size,
          ino: st.ino,
          hadEntry: cached !== undefined,
        });
      }),
    ),
  );

  // Parse changed/new files through the bounded, heavy-read-gated pipeline.
  const parseGate = createSemaphore(deps.concurrency);
  await Promise.all(
    toParse.map((item) =>
      parseGate.run(async () => {
        const partial = await deps.withSlot(() =>
          deps.read(item.path, { size: item.size, ino: item.ino }),
        );
        index.files[item.path] = {
          mtimeMs: item.mtimeMs,
          size: item.size,
          partial,
        };
        (item.hadEntry ? modifiedPaths : addedPaths).push(item.path);
        // A macrotask breath so request serving interleaves between files.
        await deps.yieldMacrotask();
      }),
    ),
  );

  const changed =
    addedPaths.length > 0 ||
    modifiedPaths.length > 0 ||
    removedPaths.length > 0;
  if (changed && deps.persist) {
    // The entries this pass moved, appended to the index's log — never the
    // whole document (see `store.ts`).
    await recordCorpusChanges(
      deps.indexPath,
      index,
      [...addedPaths, ...modifiedPaths],
      removedPaths,
    );
  }
  return { changed, addedPaths, modifiedPaths, removedPaths };
}

// ─── index instance ────────────────────────────────────────────────────────────

/** Ambient host wiring the index instance depends on (injectable for tests). */
export interface CorpusIndexEnv {
  isMain: () => boolean;
  withSlot: <R>(fn: () => Promise<R>) => Promise<R>;
  yieldMacrotask: () => Promise<void>;
  startFileWatcher: (opts: {
    dirs: string[];
    /** The paths a change batch named; its promise is coalesced by the watch. */
    onChange: (paths: readonly string[]) => Promise<unknown>;
    /** The watch reported dropped events (the only backstop); coalesced likewise. */
    onLost: () => Promise<unknown>;
  }) => Promise<void>;
  /** The declaration `startFileWatcher` opens (surfaced as `CorpusIndex.watcher`). */
  watcherRegistration: Registration;
  /** The file-system journal (file-watcher's `journalCursor` / `journalChangesSince`). */
  journal: CorpusJournal;
  /** The digest of the format's code (source-digest's `sourceDigest`). */
  digest: (code: SourceSet) => Promise<string>;
  /** A byte range of a file, for a `lines` format (`readFileRange`). */
  readRange: (path: string, start: number, end: number) => Promise<Uint8Array>;
}

/** What the index asks of the file-system journal (injectable for tests). */
export interface CorpusJournal {
  cursor: (root: string) => Promise<JournalCursorResult>;
  changesSince: (cursor: JournalCursor) => Promise<JournalReplay>;
}

// ─── boot catch-up from the journal ────────────────────────────────────────────

/**
 * The journal cursor to save for one root with the pass about to run, taken
 * BEFORE the pass, so a change landing during it is replayed again next time
 * (the fingerprint gate makes a re-check free). `undefined` when the root has
 * no journal: the next process walks it.
 */
async function takeCursor(
  root: string,
  journal: CorpusJournal,
): Promise<JournalCursor | undefined> {
  const result = await journal.cursor(root);
  return result.kind === "cursor" ? result.cursor : undefined;
}

/**
 * Every path that may have moved under `root` since its saved cursor — read
 * from the journal, not by walking — or `unknown` when the journal cannot
 * vouch for all of it (no cursor saved for the root, or its replay unknown).
 * Fail-closed: `unknown` ⇒ walk that root.
 */
async function replayRoot(
  cursor: JournalCursor | undefined,
  journal: CorpusJournal,
): Promise<JournalReplay> {
  if (cursor === undefined)
    return { kind: "unknown", reason: "no journal cursor saved" };
  return await journal.changesSince(cursor);
}

/** Whether `path` is `root` or below it. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function emptyResult(): RefreshResult {
  return {
    changed: false,
    addedPaths: [],
    modifiedPaths: [],
    removedPaths: [],
  };
}

function mergeResults(a: RefreshResult, b: RefreshResult): RefreshResult {
  return {
    changed: a.changed || b.changed,
    addedPaths: [...a.addedPaths, ...b.addedPaths],
    modifiedPaths: [...a.modifiedPaths, ...b.modifiedPaths],
    removedPaths: [...a.removedPaths, ...b.removedPaths],
  };
}

/**
 * Build a {@link CorpusIndex} against injected env — the seam `defineCorpusIndex`
 * wraps with the real host wiring and tests drive with stubs.
 */
export function createCorpusIndex<TPartial>(
  spec: CorpusIndexSpec<TPartial>,
  env: CorpusIndexEnv,
): CorpusIndex<TPartial> {
  // The in-memory index, loaded from disk once per process then kept fresh by
  // incremental refresh. A watcher marks the changed paths stale (push-based,
  // no TTL poll); every ensureFresh also does an on-demand stat-diff as the
  // correctness fallback.
  let index: CorpusFile<TPartial> | null = null;
  // What the next refresh must look at: `"all"` ⇒ walk the whole corpus (cold,
  // `markDirty`, a lost-events report, off main); a set ⇒ only the paths a watcher
  // batch named since the last pass (empty ⇒ nothing moved, on main).
  let stale: "all" | Set<string> = "all";
  let refreshInflight: Promise<CorpusDelta> | null = null;
  // The roots this process has caught up — walked, or replayed from the
  // journal — and kept fresh since. A root not in it is caught up from its own
  // saved cursor on the next pass (the catch-up on what moved while no process
  // watched it), every other root left alone; a root in it walks only when a
  // walk is asked for (`markDirty`, a lost-events report). A root that leaves
  // the root set leaves it too: nothing watches it while it is out.
  const caughtUp = new Set<string>();
  // How many times the consumer's watch of each root (re)opened.
  const watchEpoch = new Map<string, number>();
  // Who hears the corpus change, so a clean index may skip the pass: the
  // index's own watch (main) or the consumer's, which reports through
  // `markChanged` on every backend. Off both, every refresh walks.
  const consumerWatched = spec.watchedBy === "consumer";
  let watcherStarted = false;
  let watchArmed = false;
  const changeListeners = new Set<() => void>();
  const concurrency = spec.concurrency ?? DEFAULT_CONCURRENCY;

  const { match } = spec.format;
  // How a changed file is read: whole, or — for an append-only line format —
  // from where it was last read (`line-reader.ts`): this process's held state,
  // or the file's checkpoint, stamped with the format digest the index was
  // loaded with (so made on the first pass). `forget` is what a file leaving
  // the index drops.
  let reading: {
    read: RefreshDeps<TPartial>["read"];
    forget: (path: string) => Promise<void>;
  } | null = null;
  function readingFor(version: string): NonNullable<typeof reading> {
    if (spec.format.read.kind === "file")
      return { read: spec.format.read.parse, forget: async () => {} };
    const reader = createLineReader(spec.format.read.fold, {
      maxHeld: HELD_LINE_STATES,
      yieldMacrotask: env.yieldMacrotask,
      readRange: env.readRange,
      checkpoints: createCheckpointStore(
        spec.indexPath,
        version,
        computePersist(spec.scope, env.isMain()),
      ),
    });
    return {
      read: (path: string, file: FileStamp) => reader.read(path, file),
      forget: (path: string) => reader.forget(path),
    };
  }

  const resolveRoots = (): string[] =>
    typeof spec.roots === "function" ? spec.roots() : spec.roots;

  const refreshDeps = (roots: string[]): RefreshDeps<TPartial> => ({
    roots,
    match,
    read: reading!.read,
    indexPath: spec.indexPath,
    concurrency,
    persist: computePersist(spec.scope, env.isMain()),
    withSlot: env.withSlot,
    yieldMacrotask: env.yieldMacrotask,
  });

  /**
   * One pass over the corpus. `work` is what the watch said moved since the
   * last pass (a set of paths), or `"all"` when a walk was asked for. Every
   * root not yet caught up in this process is caught up from the journal when
   * its saved cursor can vouch for everything since (the paths it names go
   * through the same targeted re-check a watcher batch does), by walking that
   * root otherwise; with `"all"`, the caught-up roots are walked too. Each
   * root walked or replayed has its cursor, taken before the pass, saved with
   * the result; a root only re-checked for watcher-named paths keeps its old
   * one (events still in a debounce window at a crash would be skipped).
   */
  async function pass(
    idx: CorpusFile<TPartial>,
    roots: string[],
    work: "all" | Set<string>,
  ): Promise<RefreshResult> {
    const persist = computePersist(spec.scope, env.isMain());
    const saved = idx.cursors ?? [];
    const savedFor = (root: string): JournalCursor | undefined =>
      saved.find((c) => c.root === root);
    const walk: string[] = [];
    const paths = new Set<string>(work === "all" ? [] : work);
    const passed: string[] = [];
    const taken: JournalCursor[] = [];
    // Each root's watch epoch as the pass starts: a watch reopened meanwhile
    // (`markWatchOpened`) leaves its root NOT caught up by this pass.
    const epochs = new Map(roots.map((r) => [r, watchEpoch.get(r) ?? 0]));
    for (const root of roots) {
      const caught = caughtUp.has(root);
      if (caught && work !== "all") continue;
      // Only a persisting backend saves cursors; the others read the saved
      // ones. Taken BEFORE this root's replay or walk, so a change landing
      // during it is replayed again next time.
      if (persist) {
        const cursor = await takeCursor(root, env.journal);
        if (cursor !== undefined) taken.push(cursor);
      }
      if (caught) walk.push(root);
      else {
        const replay = await replayRoot(savedFor(root), env.journal);
        if (replay.kind === "changes")
          for (const p of replay.paths) paths.add(p);
        else walk.push(root);
      }
      passed.push(root);
    }
    const next = persist
      ? [...saved.filter((c) => !passed.includes(c.root)), ...taken]
      : saved;
    const walked =
      walk.length > 0
        ? await refreshCorpus(idx, refreshDeps(walk))
        : emptyResult();
    // A path under a walked root was just re-checked by the walk.
    const targeted = [...paths].filter((p) => !walk.some((r) => isUnder(p, r)));
    const rechecked =
      targeted.length > 0
        ? await refreshCorpusPaths(idx, targeted, refreshDeps(roots))
        : emptyResult();
    const result = mergeResults(walked, rechecked);
    for (const path of result.removedPaths) await reading!.forget(path);
    for (const root of passed)
      if ((watchEpoch.get(root) ?? 0) === epochs.get(root)) caughtUp.add(root);
    // The advanced cursors, only once the whole pass has landed: the entries
    // it moved are already in the log, and a cursor saved before them could
    // vouch for a change the stored entries do not hold yet. Cursors live in
    // the snapshot alone, so moving them writes one.
    if (persist && JSON.stringify(next) !== JSON.stringify(saved)) {
      if (next.length === 0) delete idx.cursors;
      else idx.cursors = next;
      await saveCorpusSnapshot(spec.indexPath, idx);
    }
    return result;
  }

  async function ensureFresh(): Promise<CorpusDelta> {
    index ??= await loadCorpusFile<TPartial>(
      spec.indexPath,
      await env.digest(spec.format.code),
    );
    reading ??= readingFor(index.version);
    // Watched (main's own watch, or the consumer's): only what the watch
    // named, plus any root not caught up. Unwatched: walk everything.
    const watched = consumerWatched || env.isMain();
    // Nothing moved and every root caught up ⇒ an empty delta (a real empty
    // success). A root that left the set is no longer caught up.
    if (
      watched &&
      refreshInflight === null &&
      stale !== "all" &&
      stale.size === 0 &&
      resolveRoots().every((r) => caughtUp.has(r))
    ) {
      return { addedPaths: [], modifiedPaths: [], removedPaths: [] };
    }
    // Single-flight: a concurrent second caller joins THIS promise and so
    // receives the same delta the refresh computed — never a silent empty one.
    refreshInflight ??= (async (): Promise<CorpusDelta> => {
      const roots = resolveRoots();
      for (const root of [...caughtUp])
        if (!roots.includes(root)) caughtUp.delete(root);
      // Taken BEFORE the pass: a change landing mid-pass (which may already
      // have scanned past its path) is recorded again, so the next call
      // re-checks rather than trusting this pass. A failed pass re-walks all.
      const work = watched ? stale : "all";
      stale = new Set();
      try {
        // A watcher batch names what moved: re-check those paths alone. A
        // full walk is O(corpus) — ~1.2k dirs and ~4k stats for the transcript
        // corpus — and used to run on every batch, i.e. every couple of
        // seconds while any agent was writing.
        const { addedPaths, modifiedPaths, removedPaths } = await pass(
          index!,
          roots,
          work,
        );
        if (
          addedPaths.length + modifiedPaths.length + removedPaths.length >
          0
        ) {
          for (const listener of changeListeners) listener();
        }
        return { addedPaths, modifiedPaths, removedPaths };
      } catch (err) {
        stale = "all";
        throw err;
      } finally {
        refreshInflight = null;
      }
    })();
    return await refreshInflight;
  }

  // See the interface doc: forces the next pass to walk every root.
  function markDirty(): void {
    stale = "all";
  }

  /** A watch batch: remember what it named, unless a full walk is due anyway. */
  function markPathsStale(paths: Iterable<string>): void {
    if (stale === "all") return;
    for (const p of paths) stale.add(p);
  }

  function markChanged(paths: Iterable<string>): void {
    if (!consumerWatched) {
      throw new Error(
        `corpus index "${spec.name}": markChanged() is for an index declared watchedBy: "consumer" — this one is kept fresh by its own watch (startWatcher)`,
      );
    }
    markPathsStale(paths);
  }

  function markWatchOpened(root: string): void {
    if (!consumerWatched) {
      throw new Error(
        `corpus index "${spec.name}": markWatchOpened() is for an index declared watchedBy: "consumer"`,
      );
    }
    caughtUp.delete(root);
    watchEpoch.set(root, (watchEpoch.get(root) ?? 0) + 1);
  }

  function entries(): Map<string, TPartial> {
    const out = new Map<string, TPartial>();
    if (index) {
      // Only the current roots: the index keeps an out-of-set root's entries
      // (and cursor) so it is caught up from the journal when it comes back,
      // but they are not part of the corpus while it is out.
      const roots = resolveRoots();
      for (const [path, e] of Object.entries(index.files)) {
        if (roots.some((r) => isUnder(path, r))) out.set(path, e.partial);
      }
    }
    return out;
  }

  async function startWatcher(): Promise<void> {
    if (consumerWatched) {
      throw new Error(
        `corpus index "${spec.name}" is declared watchedBy: "consumer": its consumer's watch reports through markChanged(), so the index opens none`,
      );
    }
    if (watcherStarted || !env.isMain()) return;
    watcherStarted = true;
    await env.startFileWatcher({
      dirs: resolveRoots(),
      onChange: (paths) => {
        // A corpus change: mark the paths it named stale and warm them now, so
        // the next request finds nothing (or little) to do. Returned to the
        // watch, which folds the changes landing mid-pass into one trailing
        // pass (its events merged).
        markPathsStale(paths);
        return runTracked("corpus-index:ensure-fresh", () => ensureFresh());
      },
      onLost: () => {
        // The watch says events were dropped: walk everything.
        markDirty();
        return runTracked("corpus-index:ensure-fresh", () => ensureFresh());
      },
    });
    watchArmed = true;
  }

  function onChange(listener: () => void): () => void {
    // A fresh wrapper per subscription: the same function subscribed twice is
    // two subscriptions, each with its own unsubscribe.
    const entry = () => listener();
    changeListeners.add(entry);
    return () => {
      changeListeners.delete(entry);
    };
  }

  function warmup(): Registration {
    return defineWarmup({
      name: spec.name,
      description: spec.description,
      scope: spec.scope,
      run: async () => {
        await startWatcher();
        await ensureFresh();
      },
    });
  }

  return {
    ensureFresh,
    entries,
    markDirty,
    markChanged,
    markWatchOpened,
    startWatcher,
    watching: () => watchArmed,
    onChange,
    watcher: env.watcherRegistration,
    warmup,
  };
}

/**
 * The index watcher's catalog description, DERIVED from the index's own so no
 * corpus index has a second sentence to forget or let drift.
 */
export function corpusWatcherDescription(indexDescription: string): string {
  return `Marks the index stale and re-indexes it in the background when a file under its roots changes (the whole corpus when the watch reports dropped events). ${indexDescription}`;
}

/**
 * Declare a fingerprint-keyed incremental file index over a file corpus. Wraps
 * {@link createCorpusIndex} with the real host wiring (`isMain`, the host-wide
 * heavy-read slot, a macrotask yield, and the `@parcel/watcher` primitive).
 *
 * `TPartial` is the format's (`null` for an enumerate-only one).
 */
export function defineCorpusIndex<TPartial>(
  spec: CorpusIndexSpec<TPartial>,
): CorpusIndex<TPartial> {
  // One watcher declaration per index, at define time. Main-only: only main
  // keeps a `host` index fresh by push (startWatcher is isMain()-gated too).
  //
  // No timer: a dropped event is reported by the watch (`onLost`), which
  // re-walks the corpus. A 30 s re-walk used to cost ~280 ms of stats on main
  // every tick to find nothing.
  const watcher = defineFileWatcher({
    name: `corpus-index.${spec.name}`,
    description: corpusWatcherDescription(spec.description),
    mainOnly: true,
  });
  return createCorpusIndex(spec, {
    isMain,
    journal: { cursor: journalCursor, changesSince: journalChangesSince },
    withSlot: withHeavyReadSlot,
    yieldMacrotask,
    digest: (code) => sourceDigest([code]),
    readRange: readFileRange,
    watcherRegistration: watcher,
    startFileWatcher: async ({ dirs, onChange, onLost }) => {
      // Process-lifetime watcher — the handle is intentionally discarded (the
      // original stats/cost watcher was likewise fire-and-forget, main-only).
      await watcher.start({
        dirs,
        onChange: (events) => onChange(events.map((e) => e.path)),
        onLost: () => onLost(),
      });
    },
  });
}
