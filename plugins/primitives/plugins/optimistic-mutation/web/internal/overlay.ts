// Pure overlay/replay logic for optimistic mutation. Lives apart from React so
// it can be unit-tested directly without a render. The hook
// (`use-optimistic-resource.ts`) is a thin React shell over these functions:
// the whole op lifecycle (dispatch → resolve/fail → confirm → deny/stall) is
// decided here, so the shell only owns state plumbing and the report emits.
//
// The governing policy (research/2026-07-11-global-never-revert-optimistic-edits.md):
// **pending local edits are never visually reverted.** An op leaves the overlay
// only for a CAUSAL reason that is LOCAL TO ITSELF — provably absorbed
// (confirmation) or provably superseded (a causally-later snapshot lacks its
// effect, Rule B). Failure is a sync-status state, not an undo; divergence
// without causal proof is a report, not an eviction.
//
// **The overlay is an ordered fold, so no op may be evicted on another op's
// evidence** (research/2026-09-01-global-overlay-ordered-fold-no-transitive-eviction.md).
// The rendered value is `pending.reduce(apply, serverTruth)`: removing a MIDDLE
// element changes the composition, so dropping B while an older A survives
// renders `A(base)` instead of `B(A(base))` — a state the user never created.
// That holds even with perfect evidence about B, which is why the old
// "cascade confirmation" (absorb every older same-target op when a newer one
// confirms) was deleted rather than better-evidenced. Its replacement is the
// ordering rule, enforced in `decideVerdicts`: **an op may not LEAVE the overlay
// while an older, still-surviving, same-target op is still in it.**

import { compareTxWatermark } from "@plugins/primitives/plugins/live-state/core";

/**
 * The one error an `apply` reducer may throw to say "this op no longer applies
 * to the current base" — e.g. the server already absorbed it and the row it
 * referenced is gone, or the base moved out from under a moved-relative op.
 * `replay` catches ONLY this and drops the op; any other throw is a bug in the
 * reducer and propagates loudly (fail loudly — never silence). Consumers import
 * this from the primitive's barrel and throw it from `apply` for the stale case
 * instead of throwing a bare `Error`.
 */
export class OpNoLongerApplies extends Error {
  constructor(message = "optimistic op no longer applies to the current base") {
    super(message);
    this.name = "OpNoLongerApplies";
  }
}

/**
 * How many consecutive authoritative pushes may land, after an op resolved,
 * without confirming it before the primitive files a ONE-TIME `stalled` report.
 *
 * This is a report trigger, NEVER an eviction: under push lag those "misses"
 * can be stale snapshots computed before the op's commit (delivery order is not
 * causality), so dropping the op here would revert the user's edit — the exact
 * bug the never-revert rewrite removed. The op stays in the overlay, keeps
 * replaying, and remains confirmable by any later snapshot; the report
 * preserves observability for a genuinely wrong `apply`/`isConfirmedBy` pair.
 */
export const DIVERGENCE_REPORT_MISSES = 3;

/**
 * Why an op's `mutate` rejected, while the op stays in the overlay. `network` =
 * the request never got an HTTP verdict (fetch rejected — offline, server
 * restarting): nothing is known to be wrong with the op, so it keeps rendering
 * as `syncing` and auto-retries on reconnect edges. `http` = the server failed
 * it with a TRANSIENT status (`classifyRejection`): it keeps rendering,
 * surfaces as `error`, and waits for an explicit retry.
 *
 * A PERMANENT rejection is never an `OpFailure`: the op leaves the overlay at
 * once (`rejectOp`) — see `classifyRejection`.
 */
export type OpFailure = { kind: "network" } | { kind: "http"; status: number };

/**
 * Is an HTTP failure a FINAL verdict on the op, or one a retry can overturn?
 *
 * - `permanent` — a 4xx the server will answer the same way however often the
 *   op is re-sent (a validation failure, an op that no longer applies, a
 *   missing row). Keeping such an op rendered would show a state the server
 *   has definitively refused to hold, and park every newer same-target op
 *   behind it forever — so the op is REJECTED: dropped from the overlay and
 *   reported (`optimisticRejectionSink`).
 * - `transient` — 5xx (the server failed, not the op), 401 (an expired
 *   session; the same op succeeds after re-auth), 408 and 429 (timing, not
 *   content). The op keeps rendering under never-revert, as `error` + Retry.
 *
 * Never-revert (`research/2026-07-11-global-never-revert-optimistic-edits.md`)
 * protects predictions whose outcome is UNKNOWN; a permanent rejection is a
 * known one, and dropping the op renders server truth for a causal reason,
 * exactly like a `superseded` denial
 * (`research/2026-10-08-global-rejected-optimistic-ops.md`).
 */
export function classifyRejection(status: number): "permanent" | "transient" {
  if (status < 400 || status >= 500) return "transient";
  if (status === 401 || status === 408 || status === 429) return "transient";
  return "permanent";
}

/** One pending optimistic op. `vars` is replayed via `apply` on top of base. */
export interface PendingOp<Vars> {
  opId: string;
  vars: Vars;
  /** Set once the network `mutate(vars)` promise resolves (server accepted). */
  resolved: boolean;
  /**
   * Cache generation (`dataUpdateCount`) observed at dispatch. Tokenless coarse
   * confirmation compares against it: a strictly greater generation proves an
   * authoritative push landed *after* this op was dispatched.
   */
  dispatchGen: number;
  /**
   * Consecutive authoritative pushes since resolve that did NOT confirm this
   * op. A REPORT trigger only (see `DIVERGENCE_REPORT_MISSES`) — never evicts.
   */
  misses: number;
  /**
   * The commit's ack token (`pg_current_xact_id()::text`, Rule A), when the
   * consumer's `mutate` returned one. Stamped at the resolve edge. Enables
   * exact causal confirmation (coarse) and causal denial (content mode): a
   * snapshot whose watermark is strictly greater provably saw this commit.
   */
  ackWatermark?: string;
  /**
   * Present while the op's latest `mutate` attempt rejected (see `OpFailure`).
   * A failed op is UNRESOLVED, so it is untouchable by confirmation, denial and
   * miss counting — and, since it is still in the fold, it also blocks its
   * newer same-target ops from leaving (see `decideVerdicts`, which spells out
   * how long: until a reconnect edge for `network`, until the user's `retry()`
   * for `http`). A permanently rejected op never carries one — it is removed.
   */
  failure?: OpFailure;
  /**
   * One-shot latch: the `stalled` report for this op has been filed. Misses may
   * keep accruing, but the op is never reported twice.
   */
  divergenceReported: boolean;
  /**
   * Latency stamps (`performance.now()` — the client's own monotonic clock, so
   * the confirm signal's phases carry no clock skew). `dispatchedAt` is the
   * overlay append; `firstSentAt` / `lastSentAt` the first and latest wire
   * departure (`markSent`, at the top of the send — past the send lane), with
   * `attempts` counting them (a retry re-sends); `ackedAt` the latest 2xx
   * (`markResolved`). Read ONLY by the hook's confirm-latency sample — no
   * verdict depends on them.
   */
  dispatchedAt: number;
  firstSentAt?: number;
  lastSentAt?: number;
  attempts: number;
  ackedAt?: number;
}

/**
 * What proved an op confirmed — the latency sample's mode tag. `exact-ack`: a
 * frame's `ackTx` named the op's own commit; `watermark`: a snapshot watermark
 * strictly past its ack token (coarse); `content`: `isConfirmedBy` accepted the
 * snapshot; `tokenless`: legacy coarse ("a push landed after resolve /
 * dispatch") — NOT causal, so its timings do not prove the push carried the
 * op's commit.
 */
export type ConfirmMode = "exact-ack" | "watermark" | "content" | "tokenless";

/** One op that confirmed on an edge, with what confirmed it. */
export interface ConfirmedOp<Vars> {
  op: PendingOp<Vars>;
  mode: ConfirmMode;
}

/**
 * The outcome of one lifecycle edge (a push, or a resolve). `pending` is the
 * surviving overlay — returned by IDENTITY when nothing changed, so the React
 * shell can bail out of a state write without comparing arrays.
 *
 * - `dropped` — ops causally DENIED: a snapshot watermark strictly after their
 *   commit still lacks their effect, so they were superseded by newer server
 *   truth and removed from the overlay (rendering newer truth, not a revert).
 *   The caller reports them with `kind: "superseded"`.
 * - `stalled` — ops that just crossed `DIVERGENCE_REPORT_MISSES` for the first
 *   time. They are STILL IN `pending` (never evicted); the caller reports them
 *   once with `kind: "stalled"`.
 * - `confirmed` — ops the server absorbed, dropped from the overlay, each with
 *   the mode that proved it. Not a report: the caller times them (the
 *   `confirm` latency signal). A `denied-silent` op is in NO list.
 */
export interface ReconcileResult<Vars> {
  pending: ReadonlyArray<PendingOp<Vars>>;
  dropped: ReadonlyArray<PendingOp<Vars>>;
  stalled: ReadonlyArray<PendingOp<Vars>>;
  confirmed: ReadonlyArray<ConfirmedOp<Vars>>;
}

/**
 * Replay every pending op over `base` in insertion order. An op whose `apply`
 * throws `OpNoLongerApplies` is DROPPED from the fold (the base moved past it) —
 * this keeps replay total: a stale op can never crash the overlay or wipe out
 * the other pending ops. Any OTHER throw is a reducer bug and propagates.
 */
export function replay<Data, Vars>(
  base: Data,
  pending: ReadonlyArray<PendingOp<Vars>>,
  apply: (current: Data, vars: Vars) => Data,
): Data {
  let acc = base;
  for (const op of pending) {
    acc = safeApply(acc, op.vars, apply);
  }
  return acc;
}

/**
 * Apply one op. If `apply` throws `OpNoLongerApplies`, return the prior
 * accumulator unchanged (the op is silently dropped from the fold). Every other
 * error is re-thrown so genuine reducer bugs surface loudly rather than being
 * masked by the next authoritative push.
 */
function safeApply<Data, Vars>(
  acc: Data,
  vars: Vars,
  apply: (current: Data, vars: Vars) => Data,
): Data {
  try {
    return apply(acc, vars);
  } catch (err) {
    if (err instanceof OpNoLongerApplies) return acc;
    throw err;
  }
}

/**
 * Confirmation mode. Coarse (no `Confirmation`) means "prove a snapshot at or
 * after my commit landed" — exactly via the ack token when the consumer's
 * `mutate` returned one, or legacy "an authoritative push landed after
 * dispatch" when tokenless. Content-based asks the snapshot directly via
 * `isConfirmedBy`, and declares op identity via `sameTarget` — which is the
 * ordering rule's "are these two ops in the same fold position?" relation (see
 * `decideVerdicts`), NOT a licence to evict one on the other's evidence.
 *
 * `sameTarget` may over-approximate freely (intersection, not subset, is the
 * right relation here): a wrong `true` only makes an op WAIT one more pass,
 * never leave early.
 */
export interface Confirmation<Data, Vars> {
  isConfirmedBy: (serverData: Data, vars: Vars) => boolean;
  sameTarget: (a: Vars, b: Vars) => boolean;
}

/**
 * What one pass decided about one op. Every exit from the overlay is one of the
 * three dropping arms; every other arm KEEPS the op, and only `unconfirmed`
 * counts a miss.
 *
 * - `confirmed` — drop into `confirmed`, with the `mode` that proved it (the
 *   server absorbed it; timed, never reported).
 * - `denied` — drop into `dropped`; the caller reports it as `superseded`.
 * - `denied-silent` — drop, NOT reported: the client superseded its OWN write
 *   (a newer same-target op confirmed on this very pass), so nobody lost a race
 *   and a `superseded` report would be noise. See `classifySelfSupersession`.
 * - `unconfirmed` — keep; on a push edge this is real evidence of
 *   non-confirmation, so it costs a miss (and eventually one `stalled` report).
 * - `pending` — keep, no miss: the op is unresolved (in flight, or its `mutate`
 *   rejected). Nothing is known to be wrong with it.
 * - `blocked` — keep, no miss: the ordering rule declined to EVALUATE it this
 *   pass, because an older same-target op is still in the fold ahead of it.
 */
type Verdict =
  | { kind: "confirmed"; mode: ConfirmMode }
  | {
      kind: "denied" | "denied-silent" | "unconfirmed" | "pending" | "blocked";
    };

/**
 * What one edge's own evidence says about a single RESOLVED op, in isolation.
 * Each edge supplies this as a closure (its snapshot, its watermark, its ack
 * probe, its coarse fallback); the ordering rule and the miss/report
 * bookkeeping are shared and live outside it.
 */
type Evaluation =
  { kind: "confirmed"; mode: ConfirmMode } | { kind: "denied" | "unconfirmed" };

const UNCONFIRMED = { kind: "unconfirmed" } as const;
const DENIED = { kind: "denied" } as const;
const confirmedBy = (mode: ConfirmMode): Evaluation => ({
  kind: "confirmed",
  mode,
});

/**
 * The ordering rule: **an op may not LEAVE the overlay while an older,
 * still-surviving, same-target op remains in it.**
 *
 * Why it has to exist: the overlay is an ordered fold
 * (`pending.reduce(apply, base)`), so an op's rendered effect is defined
 * RELATIVE to the ops before it. Dropping a middle element re-composes the
 * fold and renders a state the user never created — which is why evidence
 * about op B can never license removing B while an older A it was composed on
 * top of is still replaying, however good that evidence is.
 *
 * `verdict[j]` is already final for every `j < i` because the loop runs
 * oldest-first, so this reads FINAL fates, not guesses:
 *
 * - `pending` / `unconfirmed` / `blocked` ⇒ that op SURVIVES this pass and is
 *   still ahead of us in the fold ⇒ block.
 * - `confirmed` / `denied` / `denied-silent` ⇒ that op is LEAVING on this same
 *   pass, so the base we are about to be evaluated against is past it. A denied
 *   older op in particular does not block: denial means the snapshot provably
 *   saw its commit and lacks its effect, so the base is past it, not stale with
 *   respect to it.
 *
 * **Liveness.** Blocking only ever points strictly older→newer over array
 * order, so the waits-for graph is a total order restricted to same-target
 * pairs — a DAG; no cycle is spellable. The oldest op on each target has
 * nothing older, so it is decided exactly as it would be without this rule;
 * when it leaves, its successor becomes the oldest. Every chain drains from the
 * front.
 */
function blockedByOlder<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  verdicts: ReadonlyArray<Verdict>,
  sameTarget: (a: Vars, b: Vars) => boolean,
  i: number,
): boolean {
  for (let j = 0; j < i; j++) {
    const older = verdicts[j]!.kind;
    if (older !== "pending" && older !== "unconfirmed" && older !== "blocked")
      continue;
    if (sameTarget(pending[j]!.vars, pending[i]!.vars)) return true;
  }
  return false;
}

/**
 * Decide every op's fate in ONE forward pass, oldest first — so that by the
 * time op `i` is considered, the FINAL verdict of every older op (denial
 * included) is already known and the ordering rule can read it.
 *
 * Order of the checks per op:
 *
 * 1. **Blocked first.** An op an older same-target survivor sits ahead of is
 *    not evaluated at all this pass. This gates EVERY exit route — content,
 *    exact ack, coarse, and denial alike. Gating only content would leave the
 *    fold hole open through the ack door: A deletes X, B recreates it, the net
 *    recompute produces no value change, so a standalone ack frame confirms B
 *    exactly while the cached pre-A snapshot still shows X — drop B, replay A,
 *    and X vanishes from the user's screen.
 * 2. **Unresolved ⇒ `pending`.** Failed ops are unresolved by construction
 *    (their `mutate` rejected), so confirmation, denial and miss counting are
 *    all structurally unable to touch them: they keep replaying, which IS the
 *    never-revert policy. Note they also BLOCK newer same-target ops (via the
 *    check above) — dropping a newer op while an unresolved older one is still
 *    in the fold breaks the composition exactly the same way a resolved one
 *    does; whether the older op's request is in flight has no bearing on where
 *    it sits in the fold.
 *
 *    **Consequence, stated so it is never rediscovered as a surprise:** a
 *    FAILED op parks its same-target juniors in the overlay for as long as it
 *    stays failed. A `network` failure self-heals — the next reconnect edge
 *    auto-retries it — but an `http` failure is a durable verdict that waits
 *    for the user's explicit `retry()`, so its juniors can sit there
 *    indefinitely. That is the safe direction and the whole point: those
 *    juniors keep RENDERING (the fold stays intact), they accrue no misses
 *    while blocked, and the surface is already reporting `error` because of the
 *    failed op — the cost is deferred overlay occupancy, never a reverted edit.
 * 3. Otherwise the edge's own `evaluate` closure decides.
 *
 * `sameTarget` is absent in coarse mode (the consumer declared no op identity),
 * so there is nothing to block on and every op is evaluated — coarse has always
 * been per-op and never had a cross-op rule.
 */
function decideVerdicts<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  sameTarget: ((a: Vars, b: Vars) => boolean) | undefined,
  evaluate: (op: PendingOp<Vars>) => Evaluation,
): Verdict[] {
  const verdicts: Verdict[] = [];
  for (let i = 0; i < pending.length; i++) {
    const op = pending[i]!;
    if (
      sameTarget !== undefined &&
      blockedByOlder(pending, verdicts, sameTarget, i)
    ) {
      verdicts.push({ kind: "blocked" });
      continue;
    }
    if (!op.resolved) {
      verdicts.push({ kind: "pending" });
      continue;
    }
    verdicts.push(evaluate(op));
  }
  if (sameTarget !== undefined)
    classifySelfSupersession(pending, verdicts, sameTarget);
  return verdicts;
}

/**
 * Report classification, as a second pass because it needs LOOK-AHEAD (the
 * forward loop cannot know a newer op will confirm).
 *
 * A denial whose target is written again, later in the same overlay, by an op
 * that confirmed on this very pass is the client superseding its OWN write —
 * the ordinary undo→redo shape: A (`delete X`) is oldest and unconfirmable once
 * B (`create X`) has put X back, so A is denied the moment any watermark past
 * its commit arrives. Nobody lost a race, and filing `superseded` for it would
 * bury the real races in noise. The DROP still happens (it is causally proven);
 * only the report is suppressed. Getting this classification wrong costs a
 * mis-filed report, never a lost edit — the right place for a heuristic.
 */
function classifySelfSupersession<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  verdicts: Verdict[],
  sameTarget: (a: Vars, b: Vars) => boolean,
): void {
  for (let i = 0; i < verdicts.length; i++) {
    if (verdicts[i]!.kind !== "denied") continue;
    for (let j = i + 1; j < verdicts.length; j++) {
      if (verdicts[j]!.kind !== "confirmed") continue;
      if (!sameTarget(pending[i]!.vars, pending[j]!.vars)) continue;
      verdicts[i] = { kind: "denied-silent" };
      break;
    }
  }
}

/**
 * The one place an op leaves the overlay: a pure partition of `pending` by its
 * already-decided `verdicts`, plus the miss/report bookkeeping. It decides
 * nothing itself — every judgement was made in `decideVerdicts`.
 *
 * - `confirmed` ⇒ dropped into `confirmed` with its mode (timed, not reported).
 * - `denied-silent` ⇒ dropped, in NO output list.
 * - `denied` ⇒ dropped into `dropped`; the caller reports it as `superseded`.
 * - `pending` / `blocked` ⇒ kept unchanged, and **no miss**. A miss means "a
 *   fresh snapshot arrived and still doesn't reflect the op" — evidence of
 *   non-confirmation. A pass we declined to evaluate (blocked) or could not
 *   evaluate (unresolved) produced no such evidence, and counting it would file
 *   a `stalled` report about a verdict we never formed. The front of each
 *   same-target chain is never blocked, so the investigation signal survives.
 * - `unconfirmed` ⇒ kept; with `countMisses` (the push edge) `misses + 1`, and
 *   crossing `DIVERGENCE_REPORT_MISSES` for the first time also returns the op
 *   in `stalled` (one-shot latch, `divergenceReported`) — the op itself is KEPT.
 *   Without `countMisses` (resolve / ack edges) no new snapshot arrived, so a
 *   non-confirmation carries no information and the op survives unchanged.
 *
 * Returns `pending` BY IDENTITY when nothing changed, so the React shell can
 * skip the state write (and the overlay recompute it would trigger).
 */
function reconcile<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  verdicts: ReadonlyArray<Verdict>,
  countMisses: boolean,
): ReconcileResult<Vars> {
  const kept: PendingOp<Vars>[] = [];
  const dropped: PendingOp<Vars>[] = [];
  const stalled: PendingOp<Vars>[] = [];
  const confirmed: ConfirmedOp<Vars>[] = [];
  let changed = false;

  for (let i = 0; i < pending.length; i++) {
    const op = pending[i]!;
    const verdict = verdicts[i]!;
    switch (verdict.kind) {
      case "confirmed":
        changed = true;
        confirmed.push({ op, mode: verdict.mode });
        continue;
      case "denied-silent":
        changed = true;
        continue;
      case "denied":
        changed = true;
        dropped.push(op);
        continue;
      case "pending":
      case "blocked":
        kept.push(op);
        continue;
      case "unconfirmed": {
        if (!countMisses) {
          kept.push(op);
          continue;
        }
        changed = true;
        const misses = op.misses + 1;
        if (misses >= DIVERGENCE_REPORT_MISSES && !op.divergenceReported) {
          const reported = { ...op, misses, divergenceReported: true };
          stalled.push(reported);
          kept.push(reported);
        } else {
          kept.push({ ...op, misses });
        }
        continue;
      }
    }
  }

  return changed
    ? { pending: kept, dropped, stalled, confirmed }
    : { pending, dropped, stalled, confirmed };
}

/**
 * The PUSH edge: an authoritative snapshot landed in the cache.
 * `snapshotWatermark` is the newest commit watermark seen for this
 * `(key, params)` (the client watermark registry — Rule B′), or `undefined`
 * when no watermark-carrying frame has arrived (fresh sub, central origin,
 * scoped-delta-only traffic). Undefined means "no causal floor": confirmation
 * by content or legacy-coarse still works, but nothing can be causally
 * confirmed or denied.
 *
 *   - coarse + token: confirm iff `cmp(snapshotWatermark, ackWatermark) > 0` —
 *     the snapshot provably saw the commit (exact causal coarse confirmation).
 *   - coarse tokenless (legacy): any resolved op is dropped — "a push after my
 *     mutation resolved confirms me".
 *   - content-based: a resolved op is dropped when `isConfirmedBy(serverData,
 *     vars)` accepts the snapshot, or — denial — when it carries a token the
 *     snapshot is causally past yet still unreflected (Rule B).
 *
 * Un-resolved ops (mutate still in flight, or failed) are always kept, and so
 * is any op the ordering rule blocked behind an older same-target survivor.
 * Insertion order is preserved for the survivors. Resolved, evaluated,
 * unconfirmed survivors accrue a miss; crossing `DIVERGENCE_REPORT_MISSES`
 * files a one-shot `stalled` report — the op itself is never evicted.
 */
export function confirmPass<Data, Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  serverData: Data,
  snapshotWatermark: string | undefined,
  confirmation?: Confirmation<Data, Vars>,
  hasAck?: (txid: string) => boolean,
): ReconcileResult<Vars> {
  // Exact-ack confirmation (both modes): the server broadcast the op's own
  // commit txid in a frame's `ackTx` — the strongest possible proof its rows
  // were re-read post-commit. Confirms exactly; never denies (denial stays
  // snapshot-watermark-only). Like every other exit it is gated by the ordering
  // rule: an exact proof about THIS op still says nothing about the older
  // same-target op it is folded on top of.
  //
  // No `op.resolved` guard here (there used to be one): `decideVerdicts` returns
  // `"pending"` for an unresolved op before `evaluate` is ever called, so an
  // in-flight or failed op cannot reach this predicate. The check is gone
  // because it is unreachable, not because it stopped mattering.
  const acked = (op: PendingOp<Vars>): boolean =>
    op.ackWatermark !== undefined && hasAck?.(op.ackWatermark) === true;
  if (!confirmation) {
    // COARSE MODE HAS NO ORDERING RULE — deliberately, and not a regression
    // (coarse never had a cross-op rule of any kind). `sameTarget` is the
    // consumer's declaration of "these two ops write the same thing", and a
    // coarse consumer declared none, so there is no relation to say which ops
    // interact and no sound way to guess one. Coarse consumers are single-target
    // or serialized in practice (the conversation queue), which is why they
    // could omit it. Do not read the ordering rule as universal: it is exactly
    // as wide as the `sameTarget` a consumer supplies.
    const verdicts = decideVerdicts<Vars>(pending, undefined, (op) => {
      if (acked(op)) return confirmedBy("exact-ack");
      if (op.ackWatermark !== undefined) {
        return snapshotWatermark !== undefined &&
          compareTxWatermark(snapshotWatermark, op.ackWatermark) > 0
          ? confirmedBy("watermark")
          : UNCONFIRMED;
      }
      return confirmedBy("tokenless"); // legacy tokenless coarse: any post-resolve push confirms
    });
    return reconcile(pending, verdicts, true);
  }
  const { isConfirmedBy, sameTarget } = confirmation;
  const verdicts = decideVerdicts<Vars>(pending, sameTarget, (op) => {
    if (acked(op)) return confirmedBy("exact-ack");
    if (isConfirmedBy(serverData, op.vars)) return confirmedBy("content");
    // Denial is content-mode-only: coarse has no isConfirmedBy to say "the
    // snapshot lacks my effect", so a causally-later snapshot simply confirms.
    // Rule B, strict `>`: the snapshot provably saw this op's commit and still
    // doesn't reflect it — genuinely superseded by newer server truth.
    // Tokenless ops are NEVER denied: without a token there is no causal proof.
    if (
      snapshotWatermark !== undefined &&
      op.ackWatermark !== undefined &&
      compareTxWatermark(snapshotWatermark, op.ackWatermark) > 0
    ) {
      return DENIED;
    }
    return UNCONFIRMED;
  });
  return reconcile(pending, verdicts, true);
}

/**
 * The RESOLVE edge: `mutate(vars)` came back 2xx for `opId`. Mark it resolved,
 * stamp the endpoint's `ackWatermark` (when returned — Rule A), clear any prior
 * `failure` (a retried op just succeeded), then attempt confirmation
 * IMMEDIATELY against what the cache already holds — without this, an op whose
 * confirming push arrived *before* its own HTTP response (the structurally-
 * biased ordering: the DB change-feed pushes at commit, while the response
 * waits on the handler's post-commit tail) would sit resolved-and-unconfirmed
 * indefinitely, because the only confirming push it will ever get has already
 * been consumed.
 *
 * - content-based: confirm iff a snapshot exists and `isConfirmedBy` accepts it.
 * - coarse + token: confirm iff `cmp(snapshotWatermark, ackWatermark) > 0` —
 *   the cached snapshot provably saw this commit.
 * - coarse tokenless: confirm iff `gen > op.dispatchGen` — an authoritative
 *   push landed since dispatch.
 *
 * ONLY the resolving op is evaluated: every other op keeps its
 * non-evaluation semantics (survives unchanged, no miss). The ordering rule
 * still applies to the resolving op — a resolve is an exit like any other, and
 * letting one out of turn re-composes the fold exactly as a push edge would.
 *
 * **Tokenless-coarse soundness, stated explicitly.** `gen > dispatchGen` proves
 * *a* push arrived after dispatch, not that it carries our commit. In the rare
 * bad ordering (a push generated pre-commit, delivered post-dispatch) the op
 * drops early and the UI briefly reverts until the real push lands — which is
 * *guaranteed* to arrive, since the write committed. Bounded and self-healing;
 * never a permanent zombie. Returning the token from `mutate` upgrades a coarse
 * consumer to the exact causal check.
 *
 * No miss is counted and no denial runs on this edge: no new snapshot arrived,
 * so a non-confirmation carries no evidence.
 *
 * `serverData` must be an AUTHORITATIVE snapshot, or `undefined` when none has
 * landed yet. Anything else — a stand-in empty base — must not be passed: an
 * empty base "reflects" a remove and vacuously absorbs an update-only patch, so
 * `isConfirmedBy` would confirm the op against data the server never sent.
 */
export function resolvePass<Data, Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  opId: string,
  ackedAt: number,
  serverData: Data | undefined,
  gen: number,
  snapshotWatermark: string | undefined,
  ackWatermark: string | undefined,
  confirmation?: Confirmation<Data, Vars>,
  hasAck?: (txid: string) => boolean,
): ReconcileResult<Vars> {
  const resolved = markResolved(pending, opId, ackedAt, ackWatermark);
  const verdicts = decideVerdicts<Vars>(
    resolved,
    confirmation?.sameTarget,
    (op) => {
      // Not the resolving op: this edge holds no new evidence about it, so it
      // keeps its "kept, no miss" non-evaluation semantics.
      if (op.opId !== opId) return UNCONFIRMED;
      // Exact ack (both modes): the delta-before-HTTP-response race — the frame
      // carrying this commit's ackTx landed before its own response, so the
      // registry already remembers it. Checked first: it is strictly more precise
      // than the content/watermark/gen checks below.
      if (op.ackWatermark !== undefined && hasAck?.(op.ackWatermark) === true)
        return confirmedBy("exact-ack");
      if (confirmation) {
        return serverData !== undefined &&
          confirmation.isConfirmedBy(serverData, op.vars)
          ? confirmedBy("content")
          : UNCONFIRMED;
      }
      if (op.ackWatermark !== undefined) {
        return snapshotWatermark !== undefined &&
          compareTxWatermark(snapshotWatermark, op.ackWatermark) > 0
          ? confirmedBy("watermark")
          : UNCONFIRMED;
      }
      return gen > op.dispatchGen ? confirmedBy("tokenless") : UNCONFIRMED;
    },
  );
  // `countMisses: false` — no new snapshot arrived, so nothing here is evidence
  // of non-confirmation, for the resolving op or for anyone else.
  return reconcile(resolved, verdicts, false);
}

/**
 * The ACK edge: a standalone `{ kind: "ack" }` frame (or any ack note) landed
 * in the tx-ack registry for this tuple — a recompute that produced NO value
 * change acknowledged one or more commits. Drops every RESOLVED op whose ack
 * token the registry now remembers, and NOTHING else: no miss is counted (no
 * new snapshot arrived — a non-ack carries no evidence) and no denial ever runs
 * (`ackTx` can only confirm). Returns the input `pending` BY IDENTITY when
 * nothing changed, so the React shell skips the state write.
 *
 * The ordering rule gates this edge too, and this is the edge that most needs
 * it: a standalone ack frame is emitted precisely when the recompute produced
 * NO value change — e.g. A deletes X and B recreates it — so the cached
 * snapshot beside it still shows the pre-A world. Confirming B out of turn
 * there would drop B, replay A alone, and make X vanish.
 */
export function ackPass<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  hasAck: (txid: string) => boolean,
  sameTarget?: (a: Vars, b: Vars) => boolean,
): ReconcileResult<Vars> {
  const verdicts = decideVerdicts<Vars>(pending, sameTarget, (op) =>
    op.ackWatermark !== undefined && hasAck(op.ackWatermark)
      ? confirmedBy("exact-ack")
      : UNCONFIRMED,
  );
  return reconcile(pending, verdicts, false);
}

/**
 * Mark the op with `opId` resolved at `ackedAt` (`performance.now()`), stamping
 * its ack token (when the endpoint returned one) and clearing any prior
 * failure — a retried op that just succeeded is no longer failed. Preserves
 * array order. No-op if absent.
 */
export function markResolved<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  opId: string,
  ackedAt: number,
  ackWatermark?: string,
): PendingOp<Vars>[] {
  return pending.map((op) => {
    if (op.opId !== opId) return op;
    const { failure: _failure, ...rest } = op;
    return {
      ...rest,
      resolved: true,
      ackedAt,
      ...(ackWatermark !== undefined ? { ackWatermark } : {}),
    };
  });
}

/**
 * Record that the op's `mutate` just left for the wire at `at`
 * (`performance.now()`): the first send stamps `firstSentAt`, every send
 * (retries included) moves `lastSentAt` and counts an attempt. Preserves array
 * order. No-op if absent.
 */
export function markSent<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  opId: string,
  at: number,
): PendingOp<Vars>[] {
  return pending.map((op) =>
    op.opId === opId
      ? {
          ...op,
          firstSentAt: op.firstSentAt ?? at,
          lastSentAt: at,
          attempts: op.attempts + 1,
        }
      : op,
  );
}

/**
 * Record that the op's `mutate` rejected. The op STAYS in the overlay (the
 * edit keeps rendering — never-revert); the failure kind drives the surface's
 * sync phase (`network` ⇒ syncing + auto-retry, `http` ⇒ error + manual retry).
 * No-op if absent.
 */
export function markFailed<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  opId: string,
  failure: OpFailure,
): PendingOp<Vars>[] {
  return pending.map((op) => (op.opId === opId ? { ...op, failure } : op));
}

/**
 * Remove the op the server PERMANENTLY rejected (`classifyRejection`). A direct
 * removal, not a `reconcile` verdict: the ordering rule ("no op leaves while an
 * older same-target op remains") protects ops whose effect newer ops were
 * folded on top of — a rejected op's effect never existed on the server, so
 * nothing newer can depend on it there. Newer ops are NOT cascaded: each rides
 * the same send lane and gets its own verdict (one that depended on this op is
 * rejected in turn). Identity-preserving when absent.
 */
export function rejectOp<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  opId: string,
): ReadonlyArray<PendingOp<Vars>> {
  if (!pending.some((op) => op.opId === opId)) return pending;
  return pending.filter((op) => op.opId !== opId);
}

/** Clear the op's failure ahead of a retry re-fire. No-op if absent. */
export function clearFailure<Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  opId: string,
): PendingOp<Vars>[] {
  return pending.map((op) => {
    if (op.opId !== opId || op.failure === undefined) return op;
    const { failure: _failure, ...rest } = op;
    return rest;
  });
}
