/**
 * Pull to refresh: a touch that pulls down past the top of the page reloads
 * it, the way the phone browser does on a page that scrolls as a document.
 *
 * The app never scrolls as a document — `html` and `body` clip, and each pane
 * scrolls its own box — so the browser's own pull to refresh never sees the
 * pull (its overscroll lands on a viewport that cannot scroll). This puts it
 * back: the detector hands every wasted downward touch at the top here instead
 * of rubber-banding the content, and the page stays put while a disc drops in
 * from the top edge, its arc filling with the pull; past `ARM` it turns solid,
 * and letting go there reloads the page.
 *
 * The disc is drawn by the controller (`PullRefreshIndicator`) only while a
 * pull is on; this file owns the gesture and writes the disc's per-frame
 * styles straight onto it.
 */

/** Travel (px) the disc asymptotes to, however far the finger goes. */
export const MAX_TRAVEL = 96;
/** Travel (px) past which letting go refreshes. */
export const ARM_TRAVEL = 64;
/** How far below the top edge the disc rests while spinning, px. */
const REST = 16;
/** The disc's size, px — it starts fully above the top edge. */
export const DISC = 40;
/** The arc's circumference (r = 7) — its dash length. */
export const ARC_LENGTH = 44;
/** How long the disc takes to settle (retract or rest), ms. */
const SETTLE_MS = 260;

/** Travel for a finger distance: slope 1/1.6 at rest, saturating at `MAX_TRAVEL`. */
export function pullTravel(distance: number): number {
  if (distance <= 0) return 0;
  return MAX_TRAVEL * (1 - Math.exp(-distance / (MAX_TRAVEL * 1.6)));
}

/** What the controller provides: the disc's mount, and what a refresh does. */
export interface PullRefreshHost {
  /** Mount (true) or unmount (false) the disc. */
  setShown(shown: boolean): void;
  /** The mounted disc — null until the mount has rendered. */
  disc(): HTMLElement | null;
  /** Refresh the page. */
  refresh(): void;
}

export interface PullRefresh {
  /** A pull is on (from its first wasted delta until it is let go). */
  readonly active: boolean;
  /** Add `distance` px of finger travel downward (negative: back up). */
  pull(distance: number): void;
  /** The finger let go (`commit`) or the touch was cancelled. */
  release(commit: boolean): void;
  /** Drop any pull in progress without refreshing. */
  dispose(): void;
}

export function createPullRefresh(host: PullRefreshHost): PullRefresh {
  let active = false;
  let distance = 0;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function draw(travel: number, settle: boolean): void {
    const el = host.disc();
    if (!el) return;
    const y = travel - DISC - 8 + REST;
    el.style.transition = settle
      ? `transform ${SETTLE_MS}ms cubic-bezier(.2,.8,.2,1), opacity 200ms`
      : "";
    el.style.transform = `translateY(${y}px) rotate(${travel * 3}deg)`;
    el.style.opacity = String(Math.min(1, travel / 32));
    const progress = Math.min(1, travel / ARM_TRAVEL);
    el.style.setProperty(
      "--pull-arc-offset",
      String(ARC_LENGTH * (1 - progress * 0.85)),
    );
    el.toggleAttribute("data-armed", travel >= ARM_TRAVEL);
  }

  function clearHide(): void {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
  }

  return {
    get active() {
      return active;
    },
    pull(delta) {
      if (!active) {
        clearHide();
        active = true;
        distance = 0;
        host.setShown(true);
      }
      distance = Math.max(0, distance + delta);
      draw(pullTravel(distance), false);
    },
    release(commit) {
      if (!active) return;
      active = false;
      const armed = pullTravel(distance) >= ARM_TRAVEL;
      distance = 0;
      if (commit && armed) {
        draw(ARM_TRAVEL, true);
        host.disc()?.setAttribute("data-spinning", "");
        host.refresh();
        return; // the page goes away; the disc spins until it does
      }
      draw(0, true);
      clearHide();
      // Unmount once the retract has played (a timer, not a poll: one end).
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (!active) host.setShown(false);
      }, SETTLE_MS);
    },
    dispose() {
      clearHide();
      active = false;
      distance = 0;
      host.setShown(false);
    },
  };
}
