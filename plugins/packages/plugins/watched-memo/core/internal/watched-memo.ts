import { createKeyedCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import { whileWaiting } from "@plugins/packages/plugins/semaphore/core";
import {
  beginWait,
  markWait,
  runTracked,
} from "@plugins/infra/plugins/runtime-profiler/core";

/**
 * What a change source says moved, handed to `trigger`:
 *
 * - nothing (`trigger()`): anything `facts` or `compute` reads may have moved.
 * - `{ resync: true }`: the source lost events, so anything may have moved
 *   unheard.
 * - `{ moved: n }`: ONLY the inputs `n` names moved — the source heard nothing
 *   else. A pass whose every trigger is narrowed asks `stillHolds` first, and
 *   ends there when the held value still stands.
 */
export type WatchedTrigger<N> = { resync: true } | { moved: N };

export interface WatchedMemoOptions<T, F, N = never> {
  /** Names the profiler markers (`memo-watched-hit:<name>`, …). */
  name: string;
  /**
   * Read what `compute` needs and `signatureOf` fingerprints — the expensive
   * scan both share, so one read serves both (a git status, a dir listing).
   */
  facts: (key: string) => Promise<F>;
  /**
   * The fingerprint of every input `compute` reads, given the facts just
   * read. Only the unwatched path calls it: a watched value is kept fresh by
   * its change source, never by a probe.
   */
  signatureOf: (key: string, facts: F) => Promise<string>;
  /** The value, computed over `facts` — it never re-reads them. */
  compute: (key: string, facts: F) => Promise<T>;
  /**
   * Open `key`'s change source: call `trigger` after every change that can
   * move the value (`trigger(true)` when the source lost events and anything
   * may have moved). Resolves once the source is live — every change made
   * after that is heard — with its stop; rejects when `key` cannot be
   * watched.
   */
  changes: (
    key: string,
    trigger: (how?: WatchedTrigger<N>) => void,
  ) => Promise<() => void>;
  /**
   * Whether the held value still stands when only the inputs `moved` names
   * changed since it was computed over `held` (its facts). Read only what
   * those inputs feed — the cheap part of `facts` — and answer from it: true
   * ends the pass with no `facts` and no `compute`; false runs the full pass.
   * Absent, every pass computes. Called with the held value's OWN facts, so
   * an answer is about the value readers hold, never about a later read.
   */
  stillHolds?: (key: string, held: F, moved: readonly N[]) => Promise<boolean>;
  /** Whether a pass's value is the one held (default: JSON equality). */
  equals?: (a: T, b: T) => boolean;
  /** The `bg` span each pass runs under (default `watched-memo:<name>:pass`). */
  passLabel?: string;
}

export interface WatchedMemo<T> {
  /**
   * The value for `key`. Watched: the value the last pass computed — no
   * probe, no compute. Opening: the first pass's value. Unwatched, or after
   * a failed pass: a signature probe, then the cached value on a hit or a
   * single-flight compute on a miss, its failure thrown here.
   */
  get(key: string): Promise<T>;
  /**
   * Keep `key` watched until the returned stop runs, and hear `onChange`
   * after every pass that moved the value (or failed). Resolves once the
   * change source is live; rejects with its error when it cannot be opened.
   * Watchers of one key share one source and one pass per change.
   */
  watch(key: string, onChange: () => void): Promise<() => void>;
  /** Drop the unwatched path's cached entry for `key`. */
  evict(key: string): void;
}

/** How pass 1 ended: its value, or `none` — the get falls to the probe path. */
type FirstOutcome<T> = { ok: true; value: T } | { ok: false };

type EntryState<T, F> =
  | {
      kind: "opening";
      first: Promise<FirstOutcome<T>>;
      settle: (outcome: FirstOutcome<T>) => void;
    }
  | {
      kind: "watched";
      value: T;
      /** The facts of the pass that last ran in full — what `value` is over. */
      facts: F;
    }
  | {
      /**
       * The last pass failed. Kept for inspection only: a get takes the probe
       * path, which raises the error the CURRENT state gives.
       */
      kind: "demoted";
      error: unknown;
    };

/** One watched key: its state, its watchers, and the notify to them. */
interface Entry<T, F> {
  key: string;
  state: EntryState<T, F>;
  /** Live `watch` holds. The last one leaving closes the entry at once. */
  holders: number;
  closed: boolean;
  /** Set once the change source is live: a trigger before then is moot. */
  live: boolean;
  emit: () => void;
}

/** Why a pass runs: one per trigger folded into it. */
type PassCause<N> = { kind: "any" } | { kind: "narrow"; moved: N };

const jsonEquals = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * A memo whose freshness authority is its WATCH, not a probe on every read.
 *
 * While a key is watched, its change source drives passes — `facts`, then
 * `compute` over them — one at a time, the triggers landing mid-pass folded
 * into one trailing pass (`packages/coalesce`); a `get` returns the held value
 * with no git spawn. Every pass computes: nothing is skipped on an equal
 * signature, since a change read mid-pass and then undone would bring the
 * signature back while the value still showed it. Pass 1 starts after the
 * source is live, a change during or after a pass triggers another, and the
 * value is set before watchers hear of it — so a reader sees the newest
 * value, stale by at most the one pass in flight. That suffices because the
 * value is pushed: no ETag is minted from the held value. (Re-adding a
 * revalidate means returning the entry's own signature, never a fresh probe.)
 *
 * The one exception is keyed on WHAT changed, not on a signature: when every
 * trigger folded into a pass is narrowed (`{ moved }` — the source heard only
 * those inputs move), `stillHolds` is asked against the held value's own
 * facts, and a yes ends the pass (`memo-still-holds:<name>`). That is sound
 * where a signature skip is not: nothing else moved, so nothing read
 * mid-pass can have been undone, and the answer is about the facts the held
 * value was computed over. Any other trigger in the batch runs the full pass.
 *
 * A failed pass demotes the key — watchers are told, and `get` takes the
 * probe path, which raises the real error — until a pass succeeds again.
 *
 * Unwatched (or demoted) keys take the probe path: `facts` → `signatureOf` →
 * the cached value on a hit, else a compute single-flighted per
 * `key\0signature` over the PROBE's facts (one scan per miss, not two),
 * cached only when a re-probe after it still reads the same signature.
 *
 * There is no `prime` and no warm-on-close: a watcher cannot bypass the
 * single-flight or order a write by hand, and a closed key drops its value.
 */
export function createWatchedMemo<T, F, N = never>(
  opts: WatchedMemoOptions<T, F, N>,
): WatchedMemo<T> {
  const { name } = opts;
  const equals = opts.equals ?? jsonEquals;
  const passLabel = opts.passLabel ?? `watched-memo:${name}:pass`;
  const entries = new Map<string, Entry<T, F>>();
  const cache = new Map<string, { signature: string; value: T }>();
  const inflight = createInflight();

  const passes = createKeyedCoalescer<Entry<T, F>, PassCause<N>>({
    run: (entry, causes) => runTracked(passLabel, () => pass(entry, causes)),
  });

  function settleFirst(entry: Entry<T, F>, outcome: FirstOutcome<T>): void {
    if (entry.state.kind === "opening") entry.state.settle(outcome);
  }

  /**
   * The narrowed inputs, when every trigger folded into this pass named
   * what moved and the entry holds a value to judge — else null (full pass).
   */
  function narrowedOnly(
    entry: Entry<T, F>,
    causes: readonly PassCause<N>[],
  ): N[] | null {
    if (opts.stillHolds === undefined) return null;
    if (entry.state.kind !== "watched" || causes.length === 0) return null;
    const moved: N[] = [];
    for (const cause of causes) {
      if (cause.kind !== "narrow") return null;
      moved.push(cause.moved);
    }
    return moved;
  }

  async function pass(
    entry: Entry<T, F>,
    causes: readonly PassCause<N>[],
  ): Promise<void> {
    if (entry.closed) return;
    let value: T;
    let facts: F;
    try {
      const moved = narrowedOnly(entry, causes);
      if (moved !== null && entry.state.kind === "watched") {
        // Passes run one at a time and only a pass writes the state, so the
        // held facts are still the held value's while this runs.
        if (await opts.stillHolds!(entry.key, entry.state.facts, moved)) {
          markWait(`memo-still-holds:${name}`);
          return;
        }
      }
      facts = await opts.facts(entry.key);
      value = await opts.compute(entry.key, facts);
    } catch (error) {
      // Not rethrown: the coalescer would raise it unhandled. The probe path
      // re-raises the real error to every reader that asks.
      if (entry.closed) return;
      if (entry.state.kind === "opening") {
        // Readers awaiting pass 1 fall through to the probe path themselves.
        entry.state.settle({ ok: false });
        entry.state = { kind: "demoted", error };
        return;
      }
      entry.state = { kind: "demoted", error };
      entry.emit();
      return;
    }
    if (entry.closed) return;
    const state = entry.state;
    if (state.kind === "opening") {
      entry.state = { kind: "watched", value, facts };
      state.settle({ ok: true, value });
      return;
    }
    // Equal: keep the held object, so a reader comparing by identity sees no
    // change, and tell nobody — but take this pass's facts: the held value is
    // over them now (a merge-base can move and leave the list the same).
    if (state.kind === "watched" && equals(state.value, value)) {
      entry.state = { kind: "watched", value: state.value, facts };
      return;
    }
    entry.state = { kind: "watched", value, facts };
    entry.emit();
  }

  function close(entry: Entry<T, F>): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entries.get(entry.key) === entry) {
      entries.delete(entry.key);
      // Lifecycle cleanup with the last watcher, as an unwatched get would
      // otherwise keep the key's probe entry for good.
      cache.delete(entry.key);
    }
    settleFirst(entry, { ok: false });
  }

  const hub = createRefcountHub<void>(async (key, emit) => {
    let settle!: (outcome: FirstOutcome<T>) => void;
    const first = new Promise<FirstOutcome<T>>((resolve) => {
      settle = resolve;
    });
    const entry: Entry<T, F> = {
      key,
      state: { kind: "opening", first, settle },
      holders: 0,
      closed: false,
      live: false,
      emit: () => emit(),
    };
    entries.set(key, entry);
    let stop: () => void;
    try {
      stop = await opts.changes(key, (how) => {
        if (how !== undefined && "resync" in how) {
          markWait(`memo-resync:${name}`);
        }
        if (!entry.live || entry.closed) return;
        passes.trigger(entry, [
          how !== undefined && "moved" in how
            ? { kind: "narrow", moved: how.moved }
            : { kind: "any" },
        ]);
      });
    } catch (err) {
      close(entry);
      throw err;
    }
    entry.live = true;
    // Pass 1 starts after the source is live, so it reads every change the
    // source did not report.
    if (!entry.closed) passes.trigger(entry, [{ kind: "any" }]);
    return () => {
      close(entry);
      stop();
    };
  });

  async function probe(key: string): Promise<T> {
    const facts = await opts.facts(key);
    const signature = await opts.signatureOf(key, facts);
    const hit = cache.get(key);
    if (hit?.signature === signature) {
      markWait(`memo-hit:${name}`);
      return hit.value;
    }
    // Join only a compute probed at THIS signature: one probed at an earlier
    // one may hand back a value older than the state this caller read.
    return inflight.run(
      `${key}\0${signature}`,
      async () => {
        markWait(`memo-miss:${name}`);
        const value = await opts.compute(key, facts);
        // Cache only when a re-probe still reads `signature`: the compute may
        // have read a later state that has since been undone, and caching it
        // under `signature` would serve the undone state for good.
        const again = await opts.signatureOf(key, await opts.facts(key));
        if (again === signature) {
          // Already cached under `signature` (a compute that landed first):
          // the same answer — hand back THAT object, so every reader of one
          // signature holds one object.
          const held = cache.get(key);
          if (held?.signature === signature) return held.value;
          cache.set(key, { signature, value });
        }
        return value;
      },
      { onJoin: () => beginWait(`memo-coalesce:${name}`, "join") },
    );
  }

  return {
    async get(key) {
      const entry = entries.get(key);
      if (entry?.state.kind === "watched") {
        markWait(`memo-watched-hit:${name}`);
        return entry.state.value;
      }
      if (entry?.state.kind === "opening") {
        // Pass 1 is the watch's work, not this reader's: wait for it holding
        // no yieldable gate slot (`whileWaiting`), and charge the wait as one.
        // Holding it, every reader of a just-opened key (a resubscribe herd
        // after a restart: each open conversation's pages and meta) sat on a
        // read-admission slot for the whole first git pass, and every
        // unrelated read queued behind them (2026-11-06: `wait read-admit`
        // 2–17 s behind edited-files).
        const end = beginWait(`memo-opening:${name}`, "join");
        const outcome = await whileWaiting(entry.state.first).finally(end);
        if (outcome.ok) return outcome.value;
      }
      return probe(key);
    },
    async watch(key, onChange) {
      const hold = hub.acquire(key, () => onChange());
      // `acquire` opened (or joined) the entry synchronously — unless it
      // joined an open that has already failed (its entry is closed, the
      // hub's own forgetting a microtask behind): that hold's `ready` rejects.
      const entry = entries.get(key);
      if (entry === undefined) {
        await hold.ready;
        throw new Error(`[watched-memo] ${name}: ${key} has no open entry`);
      }
      entry.holders += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        entry.holders -= 1;
        // Close at once — before the source's stop, which the hub defers
        // until an open in flight lands — so readers awaiting pass 1 are
        // answered now.
        if (entry.holders === 0) close(entry);
        hold.release();
      };
      try {
        await hold.ready;
      } catch (err) {
        release();
        throw err;
      }
      return release;
    },
    evict(key) {
      cache.delete(key);
    },
  };
}
