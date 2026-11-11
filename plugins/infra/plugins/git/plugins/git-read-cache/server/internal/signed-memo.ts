/**
 * Signed memo — a `createGitStateMemo` whose signature and compute are bound at
 * construction, so a resource's `revalidate` and its `loader` are provably the
 * same authority over the same inputs.
 *
 * See research/2026-07-09-global-etag-value-coproduction.md.
 */
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { beginWait } from "@plugins/infra/plugins/runtime-profiler/core";
import { createGitStateMemo, type MemoGetOptions } from "./git-state-memo";

/**
 * What a memo's `signature` / `get` take beside the key: nothing for a memo
 * whose compute reads its inputs itself (`I = void`), else `{ input }` — the
 * facts the caller already holds (a resource's followed rows), handed to both
 * bound functions so the signature fingerprints exactly what the compute reads.
 */
type SignatureArgs<I> = [I] extends [void] ? [] : [opts: { readonly input: I }];
type GetArgs<I> = [I] extends [void]
  ? [opts?: MemoGetOptions]
  : [opts: MemoGetOptions & { readonly input: I }];

export interface SignedMemo<T, I = void> {
  /**
   * The bound signature probe — the same one `get` reads through. Feeds a
   * resource's `revalidate`. Cheap, UNGATED (acquires no heavy slot), runs on
   * every read, and fingerprints every input `compute` depends on — the
   * caller's `input` included.
   */
  signature(key: string, ...args: SignatureArgs<I>): Promise<string>;
  /**
   * Read through the memo: probe `signature`, return the cached value iff the
   * signature is unchanged, else single-flight `compute` (keyed by `key`) and
   * cache its result under the freshly probed signature. Feeds a resource's
   * `loader`.
   *
   * A signature hit short-circuits BEFORE any compute, so it acquires no heavy
   * slot at all — `compute` owns its own `withHeavyReadSlot`; the memo never
   * touches the heavy-read gate.
   *
   * `opts.notBefore` refuses to join a compute that started before it (see
   * `MemoGetOptions`). `opts.input` (a memo over caller-held inputs) is handed
   * to both the probe and the compute — one value, so the signature cached
   * under is the signature of the input computed from.
   */
  get(key: string, ...args: GetArgs<I>): Promise<T>;
  /**
   * Write-through prime from an **authoritative external writer** that already
   * holds both a value and the signature it belongs to (e.g. the @parcel watcher
   * behind edited-files, the sole source of truth for working-tree state). A
   * subsequent `get` probing the same signature is a pure cache hit — no
   * `compute`, no heavy slot.
   *
   * **Ordering contract: the writer MUST capture `signature` BEFORE running its
   * compute.** Then a change landing mid-compute leaves the stored signature
   * *older* than the value it labels: the next `get` probes a newer signature,
   * misses, and recomputes. Priming in that order over-invalidates (one needless
   * recompute); it can never serve a torn value under a matching signature.
   * Capturing the signature *after* the compute inverts this — the stored
   * signature would describe a snapshot newer than the value, and every
   * subsequent `get` would hit and serve that stale value until the next change.
   *
   * **And it MUST prime only if a re-probe AFTER the compute still returns
   * `signature`** (as `get` does for its own computes) — unless the signature
   * can never come back to an earlier value (an append-only chain). Otherwise
   * a change landing mid-compute and later undone leaves the stored signature
   * current again over a value that carries the undone change: a hit, for good.
   */
  prime(key: string, signature: string, value: T): void;
  /** Drop the cached entry for `key` (subscription-lifecycle cleanup). */
  evict(key: string): void;
}

/**
 * Git-state-keyed result memo with its signature and compute **bound at
 * construction** — one declaration site, one authority.
 *
 * `createGitStateMemo.get(key, signatureFn, computeFn)` takes both functions
 * *per call*, so two call sites can pass functions that disagree about what
 * "current" means. A resource's `revalidate` and its `loader` are exactly two
 * such call sites, and that is how `edited-files` drifted: `revalidate` probed
 * git directly while the loader's memo keyed on a watcher generation counter, so
 * a fresh ETag certified a stale value — a permanent client-side stale pin
 * (`invalidate`-mode pushes carry no value, so nothing could heal it).
 *
 * Here `signature` and `compute` come from one object: `memo.signature` feeds
 * `revalidate`, `memo.get` feeds the `loader`, and they cannot diverge because
 * there is nothing to pass. Divergence becomes structurally unrepresentable
 * rather than a comment two files apart. That is the enforcement
 * `createGitStateMemo` lacks.
 *
 * **Inputs.** A compute that reads its own inputs (git, the filesystem)
 * takes the key alone. One whose caller already HOLDS its inputs — a live
 * value's followed rows (network/live's `follows`), read fresh in the hook's
 * own call — declares them as `I`: `signature(key, input)` / `compute(key,
 * input)`, and the caller passes `{ input }` to `memo.signature` / `memo.get`.
 * The memo reads nothing a second time, and the cached signature fingerprints
 * the input, so an entry computed from other facts is never a hit.
 *
 * Everything else — the `Map<key, {signature, value}>` cache, the embedded
 * per-key `createInflight` single-flight, the `markWait` hit/miss markers and
 * the `beginWait` coalesce wait, the same-signature-only join of a mid-flight caller — is
 * `createGitStateMemo`'s, unchanged: this is a thin binding wrapper over exactly
 * one cache implementation.
 *
 * See research/2026-07-09-global-etag-value-coproduction.md and
 * research/2026-06-19-global-incremental-git-loaders.md.
 */
export function createSignedMemo<T, I = void>(opts: {
  name: string;
  signature: (key: string, input: I) => Promise<string>;
  compute: (key: string, input: I) => Promise<T>;
  /**
   * Share one signature probe among the concurrent callers that ask for the
   * same `(key, input)` — `inputKey` spells the input — instead of each
   * running its own. For a probe that touches the filesystem and is asked N
   * times at once (every value derived from one source, resubscribing
   * together): the N become joiners of one probe, holding no yieldable gate
   * slot while they wait and charging the time as a `signature-join:<name>`
   * wait.
   *
   * Sound only for a memo whose change signal is its `prime`: the writer
   * primes before it tells anyone the source changed. A probe that started
   * before the key's last `prime` is then never joined, so a read reacting to
   * a change cannot inherit a pre-change signature; the post-compute re-probe
   * never joins one that started before the compute ended. What a joiner can
   * still get is a signature read a moment before it asked, of a change no
   * prime has announced yet — older than the value it later labels (the safe
   * direction), and followed by the prime and notify that re-read it.
   */
  shareProbes?: { inputKey: (input: I) => string };
}): SignedMemo<T, I> {
  const memo = createGitStateMemo<T>({ name: opts.name });
  // `I = void` passes no `{ input }`: its functions are handed `undefined`,
  // which is their `void`.
  const inputOf = (args: readonly unknown[]): I =>
    (args[0] as { input?: I } | undefined)?.input as I;
  const probe = signatureProbe(opts);
  return {
    signature(key, ...args) {
      return probe.run(key, inputOf(args), undefined);
    },
    get(key, ...args) {
      const input = inputOf(args);
      const callerFloor = args[0]?.notBefore;
      return memo.get(
        key,
        (fresh) =>
          probe.run(key, input, maxFloor(callerFloor, fresh?.notBefore)),
        () => opts.compute(key, input), // compute owns withHeavyReadSlot
        args[0],
      );
    },
    prime(key, signature, value) {
      probe.changed(key);
      memo.set(key, signature, value);
    },
    evict(key) {
      memo.evict(key);
    },
  };
}

function maxFloor(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * The memo's signature probe: the bound function itself, or — `shareProbes` —
 * one flight per `(key, input)` that concurrent callers join, refused to any
 * caller whose floor (the key's last prime, or the caller's own) is later than
 * the flight's start.
 */
function signatureProbe<I>(opts: {
  name: string;
  signature: (key: string, input: I) => Promise<string>;
  shareProbes?: { inputKey: (input: I) => string };
}): {
  run: (
    key: string,
    input: I,
    notBefore: number | undefined,
  ) => Promise<string>;
  changed: (key: string) => void;
} {
  const share = opts.shareProbes;
  if (share === undefined) {
    return {
      run: (key, input) => opts.signature(key, input),
      changed: () => {},
    };
  }
  const flights = createInflight();
  // Per key: how many of its probes are running, and the instant of its last
  // prime while any was. Only a running probe can be joined, so a prime with
  // none running needs no floor (every later probe starts after it), and the
  // floor goes with the key's last running probe — both maps hold only keys
  // with a probe in flight.
  const running = new Map<string, number>();
  const changedAt = new Map<string, number>();
  return {
    run(key, input, notBefore) {
      return flights.run(
        `${key}\0${share.inputKey(input)}`,
        async () => {
          running.set(key, (running.get(key) ?? 0) + 1);
          try {
            return await opts.signature(key, input);
          } finally {
            const left = (running.get(key) ?? 1) - 1;
            if (left === 0) {
              running.delete(key);
              changedAt.delete(key);
            } else {
              running.set(key, left);
            }
          }
        },
        {
          notBefore: maxFloor(changedAt.get(key), notBefore),
          onJoin: () => beginWait(`signature-join:${opts.name}`, "join"),
        },
      );
    },
    changed(key) {
      if (running.has(key)) changedAt.set(key, performance.now());
    },
  };
}
