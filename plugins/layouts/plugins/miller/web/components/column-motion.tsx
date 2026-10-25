import { Component, type ReactNode, type RefObject } from "react";
import { prefersReducedMotion } from "@plugins/primitives/plugins/css/plugins/motion/web";
import {
  cloneWithScroll,
  restoreScrollOffset,
  scrollChildIntoView,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import type { MatchEntry } from "@plugins/primitives/plugins/pane/web";

/** The wrapper attribute a column is found by — its pane slot's `uuid`. */
export const COLUMN_ATTR = "data-miller-column";

const DURATION = 280;
// An ease-out gentle enough that the duration reads: an expo-style curve
// finishes 80% of the motion in the first fifth and every speed looks alike.
const EASE_OUT = "cubic-bezier(.33, 1, .68, 1)";

/**
 * A column React is about to remove, copied while it is still on screen:
 * - `leave` — closed (nothing took its place): the entrance in reverse.
 * - `swap` — replaced in place by another entity of the same pane (or a new
 *   root): only fades, over the newcomer rising in underneath.
 */
interface Ghost {
  node: HTMLElement;
  carryScroll: () => void;
  /** Left edge in the row's scroll-content coordinates, and width. */
  left: number;
  width: number;
  kind: "leave" | "swap";
}

/** What a commit removing columns leaves to draw: their ghosts, and the row's
 *  scroll offset before the commit (which may clamp it mid-way). */
interface Leaving {
  ghosts: Ghost[];
  scrollLeft: number;
}

interface ColumnMotionProps {
  /** The row of columns — the scroll container the ghosts are drawn in. */
  rowRef: RefObject<HTMLElement | null>;
  panes: readonly MatchEntry[];
  children: ReactNode;
}

/**
 * Animates the row's columns as the chain changes (prototype
 * `proto-1792836852-pvwo12`, "slide"):
 *
 * - **enter** — a new kind of pane: its content slides in from 36px right while
 *   fading in. The row's widths commit at once (no width transition), so only
 *   the newcomer moves and no column re-wraps frame by frame. When a column
 *   left in the same change, the newcomer waits a beat for it.
 * - **leave** — the entrance in reverse: a closed column is lifted out of flow
 *   at its last rect (a copy of its DOM, on top) and its content slides 36px
 *   right while fading out, over the same duration and curve as an entrance;
 *   the remaining columns take their new widths underneath at once, and a row
 *   scrolled to reveal the column glides back as it leaves.
 * - **swap** — the same pane showing another entity in the same position, or
 *   a new root column: the old content fades out on top while the new one
 *   fades in with a 4px rise.
 *
 * Keyed by the slot's `uuid`, which a back/forward or reload restores, so a
 * rebuilt route does not replay. The first paint never animates, and
 * `prefers-reduced-motion` gets the fades without the movement. Moving content
 * stays inside its column's clip, so no motion widens the row's scroll area.
 *
 * A class because a leaving column must be copied before React removes it,
 * and no hook runs before the commit's mutations: `getSnapshotBeforeUpdate`
 * copies it, `componentDidUpdate` draws and animates it before paint.
 */
export class ColumnMotion extends Component<
  ColumnMotionProps,
  object,
  Leaving | null
> {
  override getSnapshotBeforeUpdate(
    prev: Readonly<ColumnMotionProps>,
  ): Leaving | null {
    const row = this.props.rowRef.current;
    const next = this.props.panes;
    if (prev.panes === next || !row) return null;
    const kept = new Set(next.map((e) => e.uuid));
    const removed = prev.panes
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => !kept.has(entry.uuid));
    if (removed.length === 0) return null;
    const before = new Set(prev.panes.map((e) => e.uuid));
    const rowRect = row.getBoundingClientRect();
    const ghosts: Ghost[] = [];
    for (const { entry, i } of removed) {
      const column = row.querySelector<HTMLElement>(
        `[${COLUMN_ATTR}="${entry.uuid}"]`,
      );
      if (!column) continue;
      const rect = column.getBoundingClientRect();
      const { clone, carryScroll } = cloneWithScroll(column);
      const successor = next[i];
      const swap =
        successor !== undefined &&
        !before.has(successor.uuid) &&
        (i === 0 || successor.pane.id === entry.pane.id);
      ghosts.push({
        node: clone,
        carryScroll,
        left: rect.left - rowRect.left - row.clientLeft + row.scrollLeft,
        width: rect.width,
        kind: swap ? "swap" : "leave",
      });
    }
    return { ghosts, scrollLeft: row.scrollLeft };
  }

  override componentDidUpdate(
    prev: Readonly<ColumnMotionProps>,
    _state: Readonly<object>,
    leaving: Leaving | null,
  ): void {
    const row = this.props.rowRef.current;
    if (prev.panes === this.props.panes || !row) return;
    const reduced = prefersReducedMotion();
    const ghosts = leaving?.ghosts ?? [];
    for (const ghost of ghosts) drawGhost(row, ghost, reduced);
    // The ghosts hold the scroll area open again; undo a clamp the commit's
    // removals caused before they were drawn.
    if (leaving) restoreScrollOffset(row, { left: leaving.scrollLeft });
    const left = ghosts.some((g) => g.kind === "leave");
    if (left && row.scrollLeft > settledLeft(row) + 1) {
      // The reverse of revealing a newcomer: the row glides back as the
      // columns past the remaining ones' end leave.
      scrollChildIntoView(row, lastColumn(row), {
        inline: "end",
        behavior: reduced ? "auto" : "smooth",
      });
    }

    const seen = new Set(prev.panes.map((e) => e.uuid));
    this.props.panes.forEach((entry, i) => {
      if (seen.has(entry.uuid)) return;
      const box = row
        .querySelector(`[${COLUMN_ATTR}="${entry.uuid}"]`)
        ?.querySelector("[data-pane-id]");
      if (!box) return; // a collapsed column has no box to move
      // The root column has nothing to its left to arrive beside, so a new
      // root (a sidebar switch) settles in place like a swap.
      const swap = i === 0 || prev.panes[i]?.pane.id === entry.pane.id;
      const from = reduced
        ? "none"
        : swap
          ? "translateY(4px)"
          : "translateX(36px)";
      for (const child of box.children) {
        child.animate(
          [
            { opacity: 0, transform: from },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: DURATION,
            delay: DURATION * (swap ? 0.15 : left ? 0.25 : 0),
            easing: EASE_OUT,
            fill: "backwards",
          },
        );
      }
    });
  }

  override render(): ReactNode {
    return this.props.children;
  }
}

/**
 * Draws a ghost over the row at its last rect and plays its exit. Prepended,
 * so the row's `lastElementChild` stays the newest real column; inert and
 * stripped of the attributes anything looks columns and panes up by, so for
 * its short life it is a picture, not a second copy of the pane.
 */
function drawGhost(row: HTMLElement, ghost: Ghost, reduced: boolean): void {
  const { node } = ghost;
  // What slides is the pane box's content, inside the box's own clip — the
  // column's direct child is a `display: contents` region, which no transform
  // moves.
  const box = node.querySelector("[data-pane-id]");
  node.removeAttribute(COLUMN_ATTR);
  for (const el of [node, ...node.querySelectorAll("[data-pane-id], [id]")]) {
    el.removeAttribute("data-pane-id");
    el.removeAttribute("id");
  }
  node.inert = true;
  node.setAttribute("aria-hidden", "true");
  Object.assign(node.style, {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: `${ghost.left}px`,
    width: `${ghost.width}px`,
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "1",
  });
  row.prepend(node);
  ghost.carryScroll();

  // A swap fades out on top of the newcomer rising in. A closed column plays
  // the opening animation back the way it came — the same frames reversed,
  // the same duration and curve — so it visibly leaves from the first frame.
  // The whole ghost fades (its box's own background included); the content
  // slides inside the box's clip, like the entrance.
  const swap = ghost.kind === "swap";
  const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: swap ? DURATION * 0.45 : DURATION,
    easing: swap ? "linear" : EASE_OUT,
    fill: "forwards",
  });
  fade.onfinish = () => removeWhenSettled(row, node);
  fade.oncancel = () => node.remove();
  if (swap || reduced || !box) return;
  for (const child of box.children) {
    child.animate([{ transform: "none" }, { transform: "translateX(36px)" }], {
      duration: DURATION,
      easing: EASE_OUT,
      fill: "forwards",
    });
  }
}

function lastColumn(row: HTMLElement): HTMLElement | null {
  const columns = row.querySelectorAll<HTMLElement>(`[${COLUMN_ATTR}]`);
  return columns[columns.length - 1] ?? null;
}

/** The row's scroll offset once its ghosts are gone: as far right as the
 *  remaining columns reach, no further. */
function settledLeft(row: HTMLElement): number {
  const last = lastColumn(row);
  if (!last) return 0;
  const end =
    last.getBoundingClientRect().right -
    row.getBoundingClientRect().left -
    row.clientLeft +
    row.scrollLeft;
  return Math.max(0, end - row.clientWidth);
}

/**
 * A ghost keeps the row's scroll area open while it animates; removing it
 * while the row is still scrolled past where the remaining columns reach would
 * snap the scroll (the remaining columns jumping right at the end). So a faded
 * ghost waits, hidden, for the scroll-back to arrive.
 */
function removeWhenSettled(row: HTMLElement, node: HTMLElement): void {
  if (row.scrollLeft <= settledLeft(row) + 1) {
    node.remove();
    return;
  }
  node.style.visibility = "hidden";
  const onScroll = () => {
    if (row.scrollLeft > settledLeft(row) + 1) return;
    row.removeEventListener("scroll", onScroll);
    node.remove();
  };
  row.addEventListener("scroll", onScroll);
}
