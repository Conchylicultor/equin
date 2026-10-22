import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";

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
  /** Predicate on a full path deciding whether a file belongs to the corpus. */
  match: (path: string) => boolean;
  /**
   * Per-file parse. Side-effect-free — token/data only, never persists. OPTIONAL:
   * omit it for an enumerate-only corpus (the incrementally-maintained,
   * throttled, fingerprint-keyed set of paths with no per-file payload). When
   * omitted the partial is `null` and `TPartial` is `null` (see the
   * `defineCorpusIndex` no-`parse` overload).
   */
  parse?: (path: string) => Promise<TPartial>;
  /** On-disk index file path (host-global dir or a per-worktree data dir). */
  indexPath: string;
  /**
   * `host` ⇒ a single shared index; only main PERSISTS it (`isMain()` gate) so
   * worktree backends read it and compute any delta in-memory without racing on
   * the write. `worktree` ⇒ each backend owns its index and always persists.
   */
  scope: "host" | "worktree";
  /** Bump when `TPartial`'s shape changes ⇒ a version mismatch forces a full rebuild. */
  version: number;
  /** Bounded parse/stat concurrency (defaults to {@link DEFAULT_CONCURRENCY}). */
  concurrency?: number;
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
   * Force the next {@link ensureFresh} to re-walk even on main. LOAD-BEARING (not
   * convenience): `ensureFresh` short-circuits on `!dirty && isMain()`, and
   * `dirty` is otherwise only re-set by {@link startWatcher}'s onChange. A
   * consumer that owns its OWN file watcher must NOT call `startWatcher()` (it
   * double-watches and is `isMain()`-gated), so `markDirty()` is its ONLY way to
   * invalidate the index — without it every refresh after the first would
   * silently reuse a stale index on the main backend.
   */
  markDirty(): void;
  /**
   * Main-only push freshness via `@parcel/watcher`: a corpus change marks the
   * index dirty and warms it in the background. No-op off main / if already started.
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

/** Persisted, per-file fingerprint + parsed partial. */
interface CorpusEntry<TPartial> {
  mtimeMs: number;
  size: number;
  partial: TPartial;
}

/** On-disk index document. */
export interface CorpusFile<TPartial> {
  version: number;
  files: Record<string, CorpusEntry<TPartial>>;
}

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

// ─── load / save (atomic) ──────────────────────────────────────────────────────

export async function loadCorpusFile<TPartial>(
  indexPath: string,
  version: number,
): Promise<CorpusFile<TPartial>> {
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { version, files: {} };
  }
  let parsed: CorpusFile<TPartial>;
  try {
    parsed = JSON.parse(raw) as CorpusFile<TPartial>;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { version, files: {} };
  }
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime guard on untrusted on-disk JSON */
  if (
    !parsed ||
    parsed.version !== version ||
    typeof parsed.files !== "object"
  ) {
    // Version mismatch (or a corrupt/partial file) ⇒ start empty and rebuild.
    return { version, files: {} };
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  return parsed;
}

async function saveCorpusFile<TPartial>(
  indexPath: string,
  index: CorpusFile<TPartial>,
): Promise<void> {
  await mkdir(dirname(indexPath), { recursive: true });
  // Atomic write: a partially-written index would fail the version/shape guard
  // and force a full rebuild, so write to a sibling temp file then rename.
  const tmp = `${indexPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(index), "utf8");
  await rename(tmp, indexPath);
}

// ─── enumerate ──────────────────────────────────────────────────────────────────

/**
 * Collect every file under `roots` for which `match` is true, recursing into
 * subdirectories. ENOENT at any level is tolerated (a root or dir that vanished
 * mid-walk contributes nothing). Symlinks are not followed (only `isDirectory()`
 * entries are recursed) so the walk cannot loop.
 */
async function enumerate(
  roots: string[],
  match: (path: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return;
    }
    for (const d of dirents) {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
      } else if (match(full)) {
        out.push(full);
      }
    }
  };
  for (const root of roots) {
    await walk(root);
  }
  return out;
}

// ─── refresh (incremental) ──────────────────────────────────────────────────────

/** Injectable dependencies for {@link refreshCorpus} — the testability seam. */
export interface RefreshDeps<TPartial> {
  roots: string[];
  match: (path: string) => boolean;
  parse: (path: string) => Promise<TPartial>;
  indexPath: string;
  concurrency: number;
  /** Whether to persist the index after a change (see {@link computePersist}). */
  persist: boolean;
  withSlot: <R>(fn: () => Promise<R>) => Promise<R>;
  yieldMacrotask: () => Promise<void>;
}

/**
 * Incremental refresh: enumerate the corpus, `stat` every file, re-parse only
 * those whose `(mtimeMs,size)` fingerprint changed (or are new), drop entries
 * for files that vanished. Mutates `index` in place; persists (once) if a change
 * occurred and `deps.persist` is set.
 */
export async function refreshCorpus<TPartial>(
  index: CorpusFile<TPartial>,
  deps: RefreshDeps<TPartial>,
): Promise<{
  changed: boolean;
  addedPaths: string[];
  modifiedPaths: string[];
  removedPaths: string[];
}> {
  const paths = await enumerate(deps.roots, deps.match);
  const live = new Set(paths);
  const addedPaths: string[] = [];
  const modifiedPaths: string[] = [];
  const removedPaths: string[] = [];

  // Drop entries for files that no longer exist.
  for (const path of Object.keys(index.files)) {
    if (!live.has(path)) {
      delete index.files[path];
      removedPaths.push(path);
    }
  }

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
        const partial = await deps.withSlot(() => deps.parse(item.path));
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
    await saveCorpusFile(deps.indexPath, index);
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
    /** A change or reconcile tick; its promise is coalesced by the watch. */
    onChange: () => Promise<unknown>;
  }) => Promise<void>;
  /** The declaration `startFileWatcher` opens (surfaced as `CorpusIndex.watcher`). */
  watcherRegistration: Registration;
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
  // incremental refresh. A watcher marks it dirty on corpus changes (push-based,
  // no TTL poll); every ensureFresh also does an on-demand stat-diff as the
  // correctness fallback.
  let index: CorpusFile<TPartial> | null = null;
  let dirty = true;
  let refreshInflight: Promise<CorpusDelta> | null = null;
  let watcherStarted = false;
  let watchArmed = false;
  const changeListeners = new Set<() => void>();
  const concurrency = spec.concurrency ?? DEFAULT_CONCURRENCY;

  // An omitted `parse` ⇒ an enumerate-only corpus: the partial is always `null`.
  // (The `defineCorpusIndex` overload pins `TPartial` to `null` in that case, so
  // this single assertion is sound; it is the ONE place the default is applied.)
  const parse: (path: string) => Promise<TPartial> =
    spec.parse ?? (() => Promise.resolve(null as TPartial));

  const resolveRoots = (): string[] =>
    typeof spec.roots === "function" ? spec.roots() : spec.roots;

  const refreshDeps = (): RefreshDeps<TPartial> => ({
    roots: resolveRoots(),
    match: spec.match,
    parse,
    indexPath: spec.indexPath,
    concurrency,
    persist: computePersist(spec.scope, env.isMain()),
    withSlot: env.withSlot,
    yieldMacrotask: env.yieldMacrotask,
  });

  async function ensureFresh(): Promise<CorpusDelta> {
    index ??= await loadCorpusFile<TPartial>(spec.indexPath, spec.version);
    // Main clears `dirty` after a refresh and relies on the watcher (or an
    // explicit markDirty) to set it again. Worktree backends have no watcher, so
    // they always re-check. Nothing moved ⇒ an empty delta (a real empty success).
    if (!dirty && env.isMain()) {
      return { addedPaths: [], modifiedPaths: [], removedPaths: [] };
    }
    // Single-flight: a concurrent second caller joins THIS promise and so
    // receives the same delta the refresh computed — never a silent empty one.
    refreshInflight ??= (async (): Promise<CorpusDelta> => {
      // Cleared BEFORE the pass: a change landing mid-pass (which may already
      // have scanned past its path) sets it again, so the next call re-checks
      // rather than trusting this pass. A failed pass leaves the index stale.
      dirty = false;
      try {
        const { addedPaths, modifiedPaths, removedPaths } = await refreshCorpus(
          index!,
          refreshDeps(),
        );
        if (
          addedPaths.length + modifiedPaths.length + removedPaths.length >
          0
        ) {
          for (const listener of changeListeners) listener();
        }
        return { addedPaths, modifiedPaths, removedPaths };
      } catch (err) {
        dirty = true;
        throw err;
      } finally {
        refreshInflight = null;
      }
    })();
    return await refreshInflight;
  }

  // See the interface doc: the ONLY invalidation seam for a consumer that owns
  // its own watcher (and therefore must not call startWatcher()).
  function markDirty(): void {
    dirty = true;
  }

  function entries(): Map<string, TPartial> {
    const out = new Map<string, TPartial>();
    if (index) {
      for (const [path, e] of Object.entries(index.files)) {
        out.set(path, e.partial);
      }
    }
    return out;
  }

  async function startWatcher(): Promise<void> {
    if (watcherStarted || !env.isMain()) return;
    watcherStarted = true;
    await env.startFileWatcher({
      dirs: resolveRoots(),
      onChange: () => {
        // A corpus change: mark the index stale and warm it now, so the next
        // request finds nothing (or little) to do. Returned to the watch, which
        // folds the changes landing mid-pass into one trailing pass.
        dirty = true;
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
  return `Marks the index stale and re-indexes it in the background when a file under its roots changes (every 30 s as a backstop). ${indexDescription}`;
}

/**
 * Declare a fingerprint-keyed incremental file index over a file corpus. Wraps
 * {@link createCorpusIndex} with the real host wiring (`isMain`, the host-wide
 * heavy-read slot, a macrotask yield, and the `@parcel/watcher` primitive).
 *
 * Overloaded on `parse`: omit it for an enumerate-only corpus (`CorpusIndex<null>`
 * — the incrementally-maintained set of paths with no per-file payload); supply
 * it for a per-file `TPartial` payload.
 */
export function defineCorpusIndex(
  spec: Omit<CorpusIndexSpec<null>, "parse">,
): CorpusIndex<null>;
export function defineCorpusIndex<TPartial>(
  spec: CorpusIndexSpec<TPartial>,
): CorpusIndex<TPartial>;
export function defineCorpusIndex<TPartial>(
  spec: CorpusIndexSpec<TPartial>,
): CorpusIndex<TPartial> {
  // One watcher declaration per index, at define time. Main-only: only main
  // keeps a `host` index fresh by push (startWatcher is isMain()-gated too).
  //
  // The reconcile tick re-runs the same re-index as a change would; it is a
  // backstop for a dropped fsevent, and cheap because the pass is
  // fingerprint-gated (nothing changed ⇒ nothing re-parsed).
  const watcher = defineFileWatcher({
    name: `corpus-index.${spec.name}`,
    description: corpusWatcherDescription(spec.description),
    mainOnly: true,
    reconcileMs: 30_000,
  });
  return createCorpusIndex(spec, {
    isMain,
    withSlot: withHeavyReadSlot,
    yieldMacrotask,
    watcherRegistration: watcher,
    startFileWatcher: async ({ dirs, onChange }) => {
      // Process-lifetime watcher — the handle is intentionally discarded (the
      // original stats/cost watcher was likewise fire-and-forget, main-only).
      await watcher.start({
        dirs,
        onChange: () => onChange(),
        onReconcile: () => onChange(),
      });
    },
  });
}
