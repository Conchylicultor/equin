import { useEffect, useMemo, useState } from "react";
import type { AutoScrollOptions } from "@dnd-kit/core";

/** dnd-kit's own edge band (its default), stated so the zone read here is the
 *  one it scrolls by: a fifth of the scroller's height from each edge. */
const THRESHOLD = { x: 0.2, y: 0.2 };

/** How long the pointer rests in the bottom band above the new-group card
 *  before the list scrolls: long enough that passing through on the way to the
 *  card never scrolls, short enough to read as the usual edge scroll. */
const LINGER_MS = 300;

/** A step down (toward the card) larger than this restarts the rest: the
 *  pointer is heading for the card, not resting above it. */
const APPROACH_PX = 4;

/**
 * Auto-scroll around the new-group card. The card floats over the scroller's
 * bottom edge — dnd-kit's auto-scroll band — so a pointer heading for it would
 * scroll the list away (by hundreds of px) before arriving. While the card is
 * mounted, in a scroller holding it:
 *
 * - the card's band (from its top edge down) is no scroll zone at all;
 * - the rest of the bottom band (above the card) scrolls only once the
 *   pointer has rested in it for `LINGER_MS` — hover intent: each step
 *   further down (toward the card) restarts the rest, so heading for the card,
 *   however slowly, never scrolls, while resting there (or easing back up)
 *   still does;
 * - the top band, and every scroller when no card is shown, are dnd-kit's.
 *
 * The pointer is read from the window's own `pointermove` (capture phase, so it
 * is current before dnd-kit's sensor reacts to the same event — `onDragMove`
 * lags a render and folds scroll into its delta). When a rest has lasted long
 * enough, the gate bumps a generation: a new `canScroll` (a dependency of
 * dnd-kit's scroll effect) re-runs the effect, so a resting pointer starts
 * scrolling without moving.
 */
export function useNewGroupAutoScroll(dragging: boolean): {
  options: AutoScrollOptions;
  setNewGroupNode: (el: HTMLElement | null) => void;
} {
  const [generation, setGeneration] = useState(0);
  const [gate] = useState(
    () => new ScrollGate(() => setGeneration((n) => n + 1)),
  );
  useEffect(() => (dragging ? gate.follow() : undefined), [dragging, gate]);
  const options = useMemo(
    () => scrollOptions(gate, generation),
    [gate, generation],
  );
  const setNewGroupNode = useMemo(() => gate.setCard.bind(gate), [gate]);
  return { options, setNewGroupNode };
}

/** dnd-kit's options over `gate`. `generation` is the gate's rest count: each
 *  completed rest mints a new `canScroll`, which re-runs dnd-kit's effect. */
function scrollOptions(
  gate: ScrollGate,
  generation: number,
): AutoScrollOptions {
  return {
    threshold: THRESHOLD,
    canScroll: (scroller) => gate.canScroll(scroller, generation),
  };
}

/** The pointer, the card and the rest timer of one provider. */
class ScrollGate {
  private card: HTMLElement | null = null;
  private pointerY: number | null = null;
  private restingSince: number | null = null;
  /** The lowest the pointer has been since its rest began. */
  private restY = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onRested: () => void) {}

  setCard(el: HTMLElement | null): void {
    this.card = el;
    if (!el) this.clearRest();
  }

  /** Track the pointer for one drag; returns the stop. */
  follow(): () => void {
    const onMove = (e: PointerEvent) => {
      this.pointerY = e.clientY;
    };
    window.addEventListener("pointermove", onMove, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointermove", onMove, { capture: true });
      this.pointerY = null;
      this.clearRest();
    };
  }

  canScroll(scroller: Element, _generation: number): boolean {
    const card = this.card;
    const y = this.pointerY;
    if (!card || y === null || !scroller.contains(card)) return true;
    const box = scroller.getBoundingClientRect();
    if (y < box.bottom - box.height * THRESHOLD.y) {
      this.clearRest();
      return true;
    }
    if (y >= card.getBoundingClientRect().top) {
      this.clearRest();
      return false;
    }
    const now = performance.now();
    if (this.restingSince !== null && now - this.restingSince >= LINGER_MS) {
      return true;
    }
    if (this.restingSince === null || y > this.restY + APPROACH_PX) {
      this.clearRest();
      this.restingSince = now;
      this.restY = y;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.onRested();
      }, LINGER_MS);
    }
    return false;
  }

  private clearRest(): void {
    this.restingSince = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
