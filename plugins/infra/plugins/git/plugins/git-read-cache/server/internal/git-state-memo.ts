import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { chargeWait } from "@plugins/infra/plugins/runtime-profiler/core";

/** Per-call options for `GitStateMemo.get` / `SignedMemo.get`. */
export interface MemoGetOptions {
  /**
   * Freshness floor on the `performance.now()` clock, passed straight to the
   * embedded single-flight: on a miss, refuse to JOIN a compute that started
   * before this instant and start a fresh one instead. For a caller that knows
   * an input moved at `notBefore` (and bumped the signature for it) — a compute
   * already running then cannot reflect it. Omitted ⇒ join any live compute
   * probed at the caller's own signature (never one probed at another: its
   * value could be older than the state the caller probed).
   */
  notBefore?: number;
}

export interface GitStateMemo<T> {
  /**
   * Return the memoized value for `worktreePath` if the cheap ungated
   * `signatureFn` fingerprint is unchanged since the last compute; otherwise
   * single-flight the gated `computeFn` (keyed per worktree) and cache its
   * result under the freshly probed signature.
   *
   * - `signatureFn`: cheap, UNGATED probe (runs on EVERY call, and once more
   *   after each compute — keep it ~sub-ms, e.g. one ungated `rev-parse`). It must fingerprint every input the result
   *   depends on, so a stale result is never served.
   * - `computeFn`: the expensive, gated recompute. It owns its own
   *   `withHeavyReadSlot` — the memo never touches the heavy-read gate, so a
   *   signature hit acquires NO slot at all.
   */
  get(
    worktreePath: string,
    signatureFn: () => Promise<string>,
    computeFn: () => Promise<T>,
    opts?: MemoGetOptions,
  ): Promise<T>;
  /**
   * Write-through prime: store `{ signature, value }` for `worktreePath`
   * directly, bypassing `signatureFn`/`computeFn`. For an **authoritative
   * external writer** that already computed the value and the signature it
   * belongs to — e.g. the @parcel watcher behind edited-files, which is the sole
   * source of truth for working-tree state, or the transcript watcher behind
   * jsonl-events. A subsequent `get` whose `signatureFn` returns the same
   * signature is then a pure cache hit (no `computeFn`, no heavy slot).
   *
   * The writer owns correctness: it must only set a value it knows matches the
   * signature, and must capture that signature BEFORE running its compute and
   * set only if a re-probe AFTER it still returns it (see `SignedMemo.prime`,
   * which binds this method and documents the ordering).
   */
  set(worktreePath: string, signature: string, value: T): void;
  /** Drop the cached entry for `worktreePath` (subscription-lifecycle cleanup). */
  evict(worktreePath: string): void;
}

/**
 * Git-state-keyed result memo. Three live-state levers collapse into one
 * abstraction: a cheap ungated signature probe short-circuits the gated git
 * recompute on a match (skip-redundant-work / incremental), an embedded
 * per-worktree `createInflight` folds stacked concurrent recomputes into one
 * execution (skip-in-flight), and keying on `worktreePath` (not
 * conversationId/attemptId) coalesces the fan-out across views.
 *
 * The whole point: the memo short-circuits BEFORE any heavy slot is acquired —
 * a hit acquires neither the per-worktree nor the host heavy-read slot, so the
 * storm path becomes mostly memo hits.
 *
 * See research/2026-06-19-global-incremental-git-loaders.md.
 */
export function createGitStateMemo<T>(opts: { name: string }): GitStateMemo<T> {
  const cache = new Map<string, { signature: string; value: T }>();
  const inflight = createInflight();
  return {
    async get(worktreePath, signatureFn, computeFn, getOpts) {
      const sig = await signatureFn(); // cheap, ungated, no slot
      const hit = cache.get(worktreePath);
      if (hit && hit.signature === sig) {
        // 0ms marker: hit-rate signal only — never pollutes wait timing.
        chargeWait(`git-memo-hit:${opts.name}`, 0);
        return hit.value; // short-circuit BEFORE any heavy slot
      }
      // Join only a compute probed at THIS signature (the inflight is keyed by
      // it): one that started at an earlier one may hand back a value older
      // than the state this caller probed, and a caller that stamps its result
      // with that probe (a resource's ETag) would then certify a stale value
      // under a current signature — which no later read heals once a probe of
      // it is answered "unchanged".
      return inflight.run(
        `${worktreePath}\0${sig}`,
        async () => {
          chargeWait(`git-memo-miss:${opts.name}`, 0);
          const value = await computeFn(); // computeFn owns withHeavyReadSlot
          // Cache only when the signature, re-probed after the compute, is
          // still `sig`. The compute may have read a later state than `sig`
          // (signature before value); if that state then reverted (an edit
          // undone), `{sig, value}` would be a hit serving the reverted-away
          // value for good. Re-probed equal, only a change made AND undone
          // inside the compute can still slip through. Not cached ⇒ the next
          // `get` recomputes: over-invalidation, never a stale hit.
          if ((await signatureFn()) === sig) {
            // An entry already cached under `sig` (a prime, or a fresher
            // compute, that landed while this one ran) is the same answer —
            // at least as new as this one: keep it, and hand back THAT
            // object, so every reader of `sig` holds one object and a reader
            // comparing by identity (the live runtime's unchanged-recompute
            // skip) sees no change.
            const held = cache.get(worktreePath);
            if (held?.signature === sig) return held.value;
            cache.set(worktreePath, { signature: sig, value });
          }
          return value;
        },
        // Joiners charge the time spent awaiting the shared compute to their
        // OWN enclosing entry — the starter's compute is real work, not wait.
        // `notBefore` only when the caller asks: a caller that knows an input
        // moved at an instant passes it, and a compute started before then is
        // superseded rather than joined. (A superseded compute settling late
        // caches under its own signature, re-probed — a mismatch, never a
        // torn hit.)
        {
          onWait: (ms) => chargeWait(`git-coalesce:${opts.name}`, ms),
          notBefore: getOpts?.notBefore,
        },
      );
    },
    set(worktreePath, signature, value) {
      // Write-through prime from an authoritative external writer: cache the
      // value under the signature it already knows it matches. The next `get`
      // with the same signature short-circuits with no compute and no slot.
      // An entry already held under this signature is the same answer, so it
      // stays: the object readers were handed keeps its identity (the live
      // runtime skips a recompute that returns the very object it last sent).
      if (cache.get(worktreePath)?.signature === signature) return;
      cache.set(worktreePath, { signature, value });
    },
    evict(worktreePath) {
      cache.delete(worktreePath);
    },
  };
}
