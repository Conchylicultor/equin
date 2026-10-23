import type { Hint } from "../../core";

/**
 * How long the queue collects moment requests before it shows one. Several
 * tips' moments often come together (a conversation opens: its rocket and its
 * main button both qualify); waiting a beat lets the lowest-`order` one win
 * instead of whichever component mounted first.
 */
export const SETTLE_MS = 700;

interface TipRequest {
  readonly hint: Hint;
  /** Arrival order — the tie-break between equal `order`s. */
  readonly seq: number;
}

/**
 * The contextual-tip queue, as a pure value. At most ONE tip is active; the
 * rest wait. Every transition is a function below, so the host only owns the
 * clock (one settle timer at {@link wakeAt}) and what counts as eligible.
 */
export interface TipQueue {
  readonly requests: readonly TipRequest[];
  readonly active: string | null;
  /** When the current settle window opened; null when nothing is waiting to show. */
  readonly settleFrom: number | null;
  readonly nextSeq: number;
}

export const emptyTipQueue: TipQueue = {
  requests: [],
  active: null,
  settleFrom: null,
  nextSeq: 0,
};

/** A component's moment came: ask to show `hint` (idempotent per id). */
export function requestTip(q: TipQueue, hint: Hint, now: number): TipQueue {
  if (q.requests.some((r) => r.hint.id === hint.id)) return q;
  return {
    ...q,
    requests: [...q.requests, { hint, seq: q.nextSeq }],
    nextSeq: q.nextSeq + 1,
    settleFrom: q.active === null && q.settleFrom === null ? now : q.settleFrom,
  };
}

/**
 * The moment left (its `when` turned false, or its component unmounted) — or
 * the tip was answered. Either way the request goes; if it was the active
 * tip, the next one gets a fresh settle window. The caller marks seen for an
 * answer; a withdrawal marks nothing.
 */
export function removeTip(q: TipQueue, id: string, now: number): TipQueue {
  const requests = q.requests.filter((r) => r.hint.id !== id);
  if (requests.length === q.requests.length) return q;
  if (q.active !== id) return { ...q, requests };
  return {
    ...q,
    requests,
    active: null,
    settleFrom: requests.length > 0 ? now : null,
  };
}

/**
 * Advances the queue at `now`: an active tip that stopped being eligible is
 * hidden (and the window reopens); once the settle window has elapsed, the
 * eligible request with the lowest `order` (then the earliest) becomes active.
 * Nothing eligible keeps the window open — so a seen state still loading
 * shows nothing, and the first tip appears as soon as it is known.
 */
export function stepTips(
  q: TipQueue,
  now: number,
  eligible: (hint: Hint) => boolean,
): TipQueue {
  if (q.active !== null) {
    const active = q.requests.find((r) => r.hint.id === q.active);
    if (active && eligible(active.hint)) return q;
    return stepTips({ ...q, active: null, settleFrom: now }, now, eligible);
  }
  if (q.settleFrom === null || now < q.settleFrom + SETTLE_MS) return q;
  const next = q.requests
    .filter((r) => eligible(r.hint))
    .sort(
      (a, b) => (a.hint.order ?? 0) - (b.hint.order ?? 0) || a.seq - b.seq,
    )[0];
  if (!next) return q;
  return { ...q, active: next.hint.id, settleFrom: null };
}

/** When the host should call {@link stepTips} again, or null if no window is pending. */
export function wakeAt(q: TipQueue): number | null {
  return q.active === null && q.settleFrom !== null
    ? q.settleFrom + SETTLE_MS
    : null;
}

/** The active tip's declaration. */
export function activeTip(q: TipQueue): Hint | null {
  if (q.active === null) return null;
  return q.requests.find((r) => r.hint.id === q.active)?.hint ?? null;
}
