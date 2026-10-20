/**
 * The sticky-scroll state machine, as pure functions.
 *
 * Everything decision-shaped lives here rather than in the hook, for one blunt
 * reason: jsdom ships no `IntersectionObserver`, so the hook itself is only
 * reachable from an e2e run. Mirrors the `scrollClasses` / `pinClasses` /
 * `stickyClasses` precedent — the policy is pure and separately tested, the
 * hook is thin wiring around it.
 */

/**
 * Whether the surface is chasing the bottom, or parked.
 *
 * Deliberately does NOT record *which* row it is parked on. Only storage cares
 * about that, and resolving it means a `querySelectorAll` over every anchored
 * row — which, if it lived here, would run on every scroll event of a long
 * transcript. The row is resolved once, lazily, at persist time
 * ({@link PersistedMode}).
 */
export type ScrollMode = { kind: "following" } | { kind: "anchored" };

/**
 * The storage shape: a parked surface is only worth saving with a row to park on.
 *
 * `offset` is where that row's top sat relative to the viewport's top (negative
 * once the reader is partway into it), so a tall row — a long reply, a big diff
 * — restores to the line being read rather than to its first line. Absent on
 * records written before it existed: those restore to the row's start.
 */
export type PersistedMode =
  { kind: "following" } | { kind: "anchored"; key: string; offset?: number };

export type StickySignal =
  /**
   * A scroll this hook did not author. This is the ONLY signal that can stop
   * following, which is what makes the guarantee in {@link followAction} hold.
   *
   * `movedUp` is not redundant with `sentinelVisible`, and leaving it out is a
   * real bug: a scroll *away* from the bottom begins inside the threshold, so its
   * first frames still report "at the bottom". Reading only position, the surface
   * concludes the user scrolled *to* the bottom, keeps following, and the follow
   * loop drags them back — cancelling any smooth navigation that starts from the
   * bottom (a table-of-contents jump, a `revealElement`). Direction is
   * unambiguous where position is not: moving up is leaving — unless it ended
   * at the very end (`atEnd`).
   *
   * `atEnd` (scrolled to the maximum offset) is what tells a reader leaving
   * the bottom from the browser CLAMPING the offset because content below
   * shrank — a tool card collapsing as its result lands, a placeholder giving
   * way to a shorter row. A clamp moves up and is not ours, so without it the
   * surface parked whenever the transcript shrank under a following reader,
   * and new rows then arrived off screen. A scroll that ends at the very end
   * did not leave it, whatever its direction; a reader moving up cannot land
   * there.
   */
  | {
      t: "foreign-scroll";
      sentinelVisible: boolean;
      movedUp: boolean;
      atEnd: boolean;
    }
  /** The user pressed the jump-to-bottom affordance. */
  | { t: "jump" }
  /** The consumer's `followKey` changed — an explicit "the user just acted". */
  | { t: "follow-key" };

/**
 * The next mode is a function of the signal alone — the previous mode is not an
 * input, and the absence of that parameter is the point: there is no history to
 * get wrong, no ordering hazard between the observer and the scroll listener,
 * and no state a stale closure can pin. Each signal fully determines where you
 * end up.
 */
export function nextMode(signal: StickySignal): ScrollMode {
  switch (signal.t) {
    case "jump":
    case "follow-key":
      return { kind: "following" };
    case "foreign-scroll":
      if (signal.atEnd) return { kind: "following" };
      if (signal.movedUp) return { kind: "anchored" };
      return signal.sentinelVisible
        ? { kind: "following" }
        : { kind: "anchored" };
  }
}

export type StickyAction = "none" | "scroll-to-bottom";

/**
 * The whole write policy, in one expression.
 *
 * **This is the guarantee that `research/2026-05-25-global-sticky-scroll-redesign.md`
 * demands.** That doc removed a `ResizeObserver` because a size delta is
 * *sign-blind*: opening the file pane narrows the column, text rewraps taller,
 * and "grew" is indistinguishable from "new content arrived" — so the hook
 * scrolled a reading user to the bottom.
 *
 * Bottom-proximity is now a *visibility* fact, which is sign-asymmetric: a
 * taller reflow can only push the content end further down, i.e. only ever make
 * the sentinel *less* visible. A signal that can exclusively un-follow cannot
 * drag anyone to the bottom.
 *
 * Note the converse, so nobody reads a stronger promise into this than it makes:
 * while `following`, a reflow DOES produce a scroll write. That is the entire
 * point of a tail-follower. The guarantee is "no observation-driven writes
 * **while not following**" — not "no observation-driven writes".
 */
export function followAction(
  mode: ScrollMode,
  sentinelVisible: boolean,
): StickyAction {
  if (mode.kind !== "following") return "none";
  return sentinelVisible ? "none" : "scroll-to-bottom";
}

/**
 * How far the root rect is widened horizontally. Large enough that a sentinel is
 * never horizontally outside it, whatever the content's width.
 */
const HORIZONTAL_SLACK_PX = 1_000_000;

/**
 * `IntersectionObserver` options for the bottom sentinel.
 *
 * Two corrections to the naive `{ threshold: 0 }`, both load-bearing:
 *
 * - **Bottom margin carries the pin distance.** The sentinel is zero-height, so
 *   `threshold: 0` alone would mean a pin distance of literally 0px. Growing the
 *   root rect downward by `threshold` makes it fire while the content end is
 *   still that far below the fold — preserving the option's meaning from the
 *   old `scrollHeight - scrollTop - clientHeight < threshold` arithmetic.
 * - **Horizontal margin makes the x-axis irrelevant.** On an `axis="both"`
 *   surface (the conversation transcript) a sentinel sits at the content box's
 *   left edge, so scrolling right past a wide code block would carry it out of
 *   the viewport and report "bottom not visible" while the user sits exactly at
 *   the vertical bottom. Widening the root instead of pinning the sentinel with
 *   `position: sticky` keeps the sentinel a pure zero-cost marker and puts the
 *   correction where the question is actually asked: we only ever care about the
 *   vertical axis.
 */
export function sentinelObserverOptions(threshold: number): {
  rootMargin: string;
  threshold: number;
} {
  const bottom = Math.max(0, threshold);
  return {
    rootMargin: `0px ${HORIZONTAL_SLACK_PX}px ${bottom}px ${HORIZONTAL_SLACK_PX}px`,
    threshold: 0,
  };
}

/**
 * Synchronous bottom-proximity, for the one moment the observer cannot serve.
 *
 * `IntersectionObserver` delivers **asynchronously**, so inside a `scroll`
 * handler the last delivered visibility is still describing where the surface
 * was *before* this scroll. Deciding intent from it says "you scrolled to the
 * bottom" for a scroll that just left the bottom — the surface stays following
 * and the observer's next callback drags it straight back down.
 *
 * Reading the geometry here is NOT the sign-blind mistake the old design made:
 * this runs only in response to a `scroll` event, which is a *position* change.
 * Reflow and content growth do not fire `scroll`, so this can never interpret
 * "the content got taller" as "the user moved". The observer still owns
 * everything that happens without a scroll.
 */
export function isAtBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold: number,
): boolean {
  const distance =
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distance <= Math.max(0, threshold);
}

/**
 * Scrolled to the maximum offset — where the browser clamps to when content
 * shrinks. 1px of slack: `scrollTop` is fractional on a zoomed or high-DPI
 * display, the maximum is not always reachable to the exact pixel.
 */
export function isAtEnd(metrics: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return isAtBottom(metrics, 1);
}

export type RestoreOutcome =
  | { kind: "none" }
  | { kind: "following" }
  | { kind: "anchored"; el: HTMLElement; offset?: number }
  /** Saved, but the row it named is gone. Distinct from `none` on purpose. */
  | { kind: "missing"; key: string };

/**
 * Resolve a persisted mode against the live DOM.
 *
 * `missing` is deliberately NOT folded into `none`. Collapsing them would make a
 * systematic key regression (a changed key scheme, a filter that drops the
 * anchored row, a truncated transcript) read exactly like "first visit" — an
 * absorbed failure republished as legitimate data, which `no-absorbed-failure`
 * exists to prevent. The caller decides the remedy; it is not decided here.
 */
export function resolveRestore(
  saved: PersistedMode | null,
  lookup: (key: string) => HTMLElement | null,
): RestoreOutcome {
  if (saved === null) return { kind: "none" };
  if (saved.kind === "following") return { kind: "following" };
  const el = lookup(saved.key);
  if (!el) return { kind: "missing", key: saved.key };
  return saved.offset === undefined
    ? { kind: "anchored", el }
    : { kind: "anchored", el, offset: saved.offset };
}
