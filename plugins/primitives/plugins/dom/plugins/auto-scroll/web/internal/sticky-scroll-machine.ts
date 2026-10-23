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
 * Whether the surface is chasing the bottom, being moved by the reader, or
 * parked.
 *
 * - `following` — the hook owns the offset: content growing pulls it down, and
 *   any scroll no reader input explains is put back at the bottom.
 * - `driving` — the reader (or a navigation they asked for) is moving the
 *   surface: nothing is written until their scroll settles, which decides
 *   between the other two.
 * - `anchored` — parked where the reader left it.
 *
 * Deliberately does NOT record *which* row it is parked on. Only storage cares
 * about that, and resolving it means a `querySelectorAll` over every anchored
 * row — which, if it lived here, would run on every scroll event of a long
 * transcript. The row is resolved once, lazily, at persist time
 * ({@link PersistedMode}).
 */
export type ScrollMode =
  { kind: "following" } | { kind: "driving" } | { kind: "anchored" };

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
   * The scroller's offset changed.
   *
   * - `ours` — the hook wrote it (read back after the write, so a clamp of our
   *   own write counts as ours).
   * - `armed` — reader input (wheel, touch, a pointer down in the scroller, a
   *   scroll key) or an announced navigation (`announceNavigation`, called by
   *   every sanctioned scroll funnel) happened in the settle window. Only an
   *   armed scroll is the reader's; while `driving`, every scroll is.
   * - `movedDown`, `distance` — its direction, and how far the bottom is after
   *   it (px).
   */
  | {
      t: "scroll";
      ours: boolean;
      armed: boolean;
      movedDown: boolean;
      distance: number;
    }
  /**
   * The reader's scroll came to rest (no input or scroll for the settle
   * window). `distance` is how far the bottom was at the reader's LAST scroll
   * — content that streamed in since is not their displacement.
   */
  | { t: "settle"; distance: number }
  /** The bottom sentinel entered or left the pin margin. */
  | { t: "sentinel"; visible: boolean }
  /** The user pressed the jump-to-bottom affordance. */
  | { t: "jump" }
  /** The consumer's `followKey` changed — an explicit "the user just acted". */
  | { t: "follow-key" }
  /**
   * Find-in-page was asked for (⌘F / Ctrl+F). Its scrolls reach the page with
   * no input the page can see, so asking for it parks.
   */
  | { t: "find" };

export type StickyAction = "none" | "scroll-to-bottom";

export interface StickyStep {
  mode: ScrollMode;
  action: StickyAction;
}

const FOLLOWING: ScrollMode = { kind: "following" };
const DRIVING: ScrollMode = { kind: "driving" };
const ANCHORED: ScrollMode = { kind: "anchored" };

/**
 * The whole follow policy, as one reducer.
 *
 * **Only reader evidence stops following.** Leaving `following` takes an
 * armed scroll (reader input or an announced navigation), a find, or nothing.
 * A scroll nothing explains — the browser clamping as content below shrinks,
 * its scroll anchoring, `KeepAnchorAcross` keeping a row across a window
 * slide, a `focus()` — is put back at the bottom. That is what makes "a layout
 * effect parked the follower" inexpressible: no effect, present or future,
 * produces reader input. The previous rule ("a scroll we did not write is the
 * reader leaving") was an inference by elimination, and each new effect that
 * moved the offset was a new way to park.
 *
 * **Nothing observed writes while not following** (the
 * `research/2026-05-25-global-sticky-scroll-redesign.md` guarantee): the
 * sentinel only ever writes from `following`, and visibility is
 * sign-asymmetric — a taller reflow can only make the bottom less visible — so
 * no observation drags a parked reader down.
 */
export function step(
  mode: ScrollMode,
  signal: StickySignal,
  threshold: number,
): StickyStep {
  const pin = Math.max(0, threshold);
  switch (signal.t) {
    case "jump":
    case "follow-key":
      return { mode: FOLLOWING, action: "scroll-to-bottom" };
    case "find":
      return { mode: ANCHORED, action: "none" };
    case "sentinel":
      return { mode, action: followAction(mode, signal.visible) };
    case "settle":
      if (mode.kind !== "driving") return { mode, action: "none" };
      return signal.distance <= pin
        ? { mode: FOLLOWING, action: "scroll-to-bottom" }
        : { mode: ANCHORED, action: "none" };
    case "scroll": {
      if (signal.ours) return { mode, action: "none" };
      if (signal.armed || mode.kind === "driving") {
        // The reader's. Arriving at the bottom resumes at once; anything else
        // is theirs to drive until it settles — no write fights it, and
        // stopping inside the margin still sticks.
        return signal.movedDown && signal.distance <= pin
          ? { mode: FOLLOWING, action: "none" }
          : { mode: DRIVING, action: "none" };
      }
      // Nobody asked for it. A follower is put back; a parked reader is left
      // to the browser's anchoring.
      if (mode.kind === "following" && signal.distance > END_SLACK_PX)
        return { mode, action: "scroll-to-bottom" };
      return { mode, action: "none" };
    }
  }
}

/**
 * 1px of slack for "already at the end": `scrollTop` is fractional on a zoomed
 * or high-DPI display, the maximum is not always reachable to the exact pixel.
 */
const END_SLACK_PX = 1;

/** The sentinel's write policy: chase the bottom only while following. */
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

/** How far the content end is below the viewport's bottom (px; 0 at the end). */
export function distanceToBottom(metrics: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number {
  return Math.max(
    0,
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight,
  );
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
