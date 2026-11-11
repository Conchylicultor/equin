import type { Hint } from "../../core";
import { inScope } from "./scope-key";

/**
 * How long a tip waits after its moment comes before it shows, when no tip
 * was on screen: the moment is usually a screen that just appeared (a window
 * opened on the desktop, an app launched), and a card landing in the same
 * instant asks to be read before the user has seen where they are. Waiting
 * also collects every moment that comes together (a conversation opens: its
 * rocket and its main button both qualify), so the lowest `order` wins
 * instead of whichever component mounted first.
 */
export const ORIENT_MS = 1200;

/**
 * The shorter wait for the next tip once one was answered (or hid because its
 * anchor left the screen): the user is already reading tips on a screen they
 * know — waiting a beat is enough.
 */
export const SETTLE_MS = 700;

/**
 * How long the user must have been still (no pointer move, press, wheel or
 * key) before a tip shows: a card never lands mid-gesture — while the user is
 * reaching for something, or typing — only in the pause after.
 */
export const QUIET_MS = 400;

export interface TipRequest {
  readonly hint: Hint;
  /**
   * The plugin scope that asked (`null`: the page) — whose server holds this
   * tip's seen state, and whose anchors it points at.
   */
  readonly scope: string | null;
  /** The hint id in its scope ({@link inScope}) — the request's identity. */
  readonly key: string;
  /** Arrival order — the tie-break between equal `order`s. */
  readonly seq: number;
}

/**
 * The contextual-tip queue, as a pure value. At most ONE tip is active; the
 * rest wait. Every transition is a function below, so the host only owns the
 * clock (one timer at {@link wakeAt}) and what counts as eligible.
 */
export interface TipQueue {
  readonly requests: readonly TipRequest[];
  /** The active request's key. */
  readonly active: string | null;
  /**
   * When the waiting window ends ({@link ORIENT_MS} or {@link SETTLE_MS} after
   * it opened); null when nothing is waiting to show.
   */
  readonly readyAt: number | null;
  readonly nextSeq: number;
}

export const emptyTipQueue: TipQueue = {
  requests: [],
  active: null,
  readyAt: null,
  nextSeq: 0,
};

/**
 * A component's moment came: ask to show `hint` from `scope` (idempotent per
 * hint and scope — the page and the demo each ask for their own).
 */
export function requestTip(
  q: TipQueue,
  hint: Hint,
  now: number,
  scope: string | null = null,
): TipQueue {
  const key = inScope(scope, hint.id);
  if (q.requests.some((r) => r.key === key)) return q;
  return {
    ...q,
    requests: [...q.requests, { hint, scope, key, seq: q.nextSeq }],
    nextSeq: q.nextSeq + 1,
    // The first request on a quiet queue: its screen just came — orient first.
    readyAt:
      q.active === null && q.readyAt === null ? now + ORIENT_MS : q.readyAt,
  };
}

/**
 * The moment left (its `when` turned false, or its component unmounted) — or
 * the tip was answered. Either way the request goes; if it was the active
 * tip, the next one gets a short window. The caller marks seen for an
 * answer; a withdrawal marks nothing.
 */
export function removeTip(q: TipQueue, key: string, now: number): TipQueue {
  const requests = q.requests.filter((r) => r.key !== key);
  if (requests.length === q.requests.length) return q;
  if (q.active !== key) return { ...q, requests };
  return {
    ...q,
    requests,
    active: null,
    readyAt: requests.length > 0 ? now + SETTLE_MS : null,
  };
}

/**
 * Advances the queue at `now`: an active tip that stopped being eligible is
 * hidden (and a short window reopens); once the window has elapsed and the
 * user has been still for {@link QUIET_MS} since `lastInputAt`, the eligible
 * request with the lowest `order` (then the earliest) becomes active.
 * Nothing eligible keeps the window open — so a seen state still loading
 * shows nothing, and the first tip appears as soon as it is known.
 */
export function stepTips(
  q: TipQueue,
  now: number,
  eligible: (hint: Hint, request: TipRequest) => boolean,
  lastInputAt: number = Number.NEGATIVE_INFINITY,
): TipQueue {
  if (q.active !== null) {
    const active = q.requests.find((r) => r.key === q.active);
    if (active && eligible(active.hint, active)) return q;
    return stepTips(
      { ...q, active: null, readyAt: now + SETTLE_MS },
      now,
      eligible,
      lastInputAt,
    );
  }
  const at = wakeAt(q, lastInputAt);
  if (at === null || now < at) return q;
  const next = q.requests
    .filter((r) => eligible(r.hint, r))
    .sort(
      (a, b) => (a.hint.order ?? 0) - (b.hint.order ?? 0) || a.seq - b.seq,
    )[0];
  if (!next) return q;
  return { ...q, active: next.key, readyAt: null };
}

/**
 * When the host should call {@link stepTips} again — the window's end, or
 * later while the user is still moving — or null if no window is pending.
 */
export function wakeAt(
  q: TipQueue,
  lastInputAt: number = Number.NEGATIVE_INFINITY,
): number | null {
  if (q.active !== null || q.readyAt === null) return null;
  return Math.max(q.readyAt, lastInputAt + QUIET_MS);
}

/** The active tip's request — its declaration and the scope that asked. */
export function activeRequest(q: TipQueue): TipRequest | null {
  if (q.active === null) return null;
  return q.requests.find((r) => r.key === q.active) ?? null;
}

/** The active tip's declaration. */
export function activeTip(q: TipQueue): Hint | null {
  return activeRequest(q)?.hint ?? null;
}

/**
 * Whether `request`'s tip is replaced (`Hint.supersedes`) by another in its
 * scope: one of `declared` superseding it was already shown there (`shown` —
 * seen, or answered this session), or one is asked for alongside it. Pure, so
 * the host's eligibility stays one predicate.
 */
export function isSuperseded(
  q: TipQueue,
  request: TipRequest,
  declared: readonly Hint[],
  shown: (hintId: string) => boolean,
): boolean {
  const replaces = (by: Hint) =>
    by.supersedes?.some((h) => h.id === request.hint.id) ?? false;
  if (declared.some((by) => replaces(by) && shown(by.id))) return true;
  return q.requests.some((r) => r.scope === request.scope && replaces(r.hint));
}
