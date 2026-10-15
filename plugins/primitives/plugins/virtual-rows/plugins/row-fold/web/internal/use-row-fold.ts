import { useId, useLayoutEffect, useMemo, useState } from "react";
import {
  FOLD_EASING,
  FOLD_MS,
} from "@plugins/primitives/plugins/collapsible/core";
import {
  awaitedReveal,
  detectContinuation,
  detectDisclosure,
  withFoldingRows,
  NOTHING_AWAITED,
  type AwaitedReveal,
  type IsStandIn,
  type RowDisclosure,
} from "../../core";
import { planRowFold, rowKeyframe, type RowMotion } from "./fold-plan";

export interface UseRowFoldOptions<T> {
  /** The rows as the owner flattened them — hidden ones already gone. */
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  /**
   * The open disclosures `items` were flattened under, in the owner's key
   * space: a tree's expanded ids, a table's open groups and folds. A change
   * of `items` that comes with a flip here is a disclosure and folds; any
   * other change (a window scrolling, a search, live data, a page) is drawn
   * as it lands. `undefined`: the list has no disclosures, nothing folds.
   */
  openKeys: ReadonlySet<string> | undefined;
  /**
   * Lines drawn in place of rows not listed yet — a lazy node's "Loading…"
   * placeholder, a section's footer. A toggle that revealed only these is
   * still awaited: the rows landing in their place later fold in. Default:
   * none.
   */
  isStandIn?: IsStandIn<T>;
}

export interface RowFoldHostProps {
  "data-row-fold-host": string;
}

/** Spread on each row's outermost element (a direct child of the host). */
export interface RowFoldProps {
  "data-row-fold": string;
  /** A hidden row folding away: still painted, no longer there for focus or
   *  a reader. */
  inert: boolean;
}

export interface RowFold<T> {
  /** What to draw: `items`, plus the hidden rows still folding away, in
   *  their old places. */
  items: readonly T[];
  /** Spread on the element whose direct children are the rows. Props, not a
   *  ref: the host already has its own refs, and nothing needs composing. */
  hostProps: RowFoldHostProps;
  rowProps: (key: string) => RowFoldProps;
  /** Rows the fold in flight reveals or hides (0 when none) — how far past
   *  its window a windowed list must draw so the rows sliding through the
   *  viewport exist. */
  inFlight: number;
}

/**
 * Disclosure motion for a flat list: rows a disclosure reveals grow in, rows
 * it hides fold out, and the rows below slide — the motion a nested
 * `FoldMotion` box gives its content, for a list whose disclosure inserts
 * sibling rows instead.
 *
 * The renderer owns it: `VirtualRows` and `DataTable` call it, so every list
 * drawn through them folds once its owner passes `openKeys` — the open state
 * it flattened under, which an expand model has anyway. Nothing per call
 * site records "this change was a toggle": the flip of an open key IS the
 * signal (`detectDisclosure`).
 *
 * Same clock as `FoldMotion`: the commit pins every row at its first frame,
 * the tween starts on the next animation frame from `performance.now()` (a
 * slow mount delays it rather than swallowing it), hidden rows unmount once it
 * ends, and under `prefers-reduced-motion` nothing folds at all. A disclosure
 * landing mid-fold ends the one in flight where it is.
 */
export function useRowFold<T>({
  items,
  getKey,
  openKeys,
  isStandIn = NO_STAND_INS,
}: UseRowFoldOptions<T>): RowFold<T> {
  const hostId = useId();
  // The last toggle's reveal, while it may still be arriving (`awaitedReveal`).
  const [seen, setSeen] = useState({
    items,
    openKeys,
    awaited: NOTHING_AWAITED,
  });
  const [disclosure, setDisclosure] = useState<RowDisclosure<T> | null>(null);
  if (seen.items !== items || seen.openKeys !== openKeys) {
    const step = foldStep({
      prevItems: seen.items,
      nextItems: items,
      prevOpen: seen.openKeys,
      nextOpen: openKeys,
      awaited: seen.awaited,
      getKey,
      isStandIn,
    });
    setSeen({ items, openKeys, awaited: step.awaited });
    if (step.disclosure !== null) setDisclosure(step.disclosure);
  }

  const drawn = useMemo(
    () =>
      disclosure === null ? items : withFoldingRows(items, disclosure, getKey),
    [items, disclosure, getKey],
  );
  const hiddenKeys = useMemo(
    () => new Set(disclosure?.hidden.map((row) => row.key)),
    [disclosure],
  );

  useLayoutEffect(() => {
    if (disclosure === null) return;
    // A quoted attribute value needs no escaping: a `useId` holds no quote.
    const hostEl = document.querySelector<HTMLElement>(
      `[data-row-fold-host="${hostId}"]`,
    );
    if (hostEl === null) return;
    const plan = () =>
      planRowFold(hostEl, disclosure.revealed, hiddenKeys, window.innerHeight);
    const pinned = new PinnedRows();
    const running: Animation[] = [];

    // Pin the first frame now (before paint); start the tween next frame,
    // measured there — after whatever the commit mounted has laid out.
    pinned.pin(plan());
    const frame = requestAnimationFrame(() => {
      pinned.release();
      const start = performance.now();
      const timing: KeyframeAnimationOptions = {
        duration: FOLD_MS,
        easing: FOLD_EASING,
        // Held at both ends until this fold is over: before its start time
        // a frame paints the first keyframe, and a hidden row's last frame
        // (folded away, the rows below slid up) holds until the commit that
        // drops it — which cancels it in the same frame.
        fill: "both",
      };
      for (const { el, from, to } of plan()) {
        const anim = el.animate([rowKeyframe(from), rowKeyframe(to)], timing);
        // Now, not the frame stamp, which predates any long task this frame
        // ran.
        anim.startTime = start;
        running.push(anim);
      }
      // The fold's own clock, on the host — which outlives any row a window
      // scrolls away mid-fold.
      const clock = hostEl.animate([], { duration: FOLD_MS });
      clock.startTime = start;
      running.push(clock);
      clock.onfinish = () =>
        setDisclosure((current) => (current === disclosure ? null : current));
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const anim of running) anim.cancel();
      pinned.release();
    };
  }, [disclosure, hiddenKeys, hostId]);

  return {
    items: drawn,
    hostProps: { "data-row-fold-host": hostId },
    rowProps: (key) => ({ "data-row-fold": key, inert: hiddenKeys.has(key) }),
    inFlight:
      disclosure === null
        ? 0
        : disclosure.revealed.size + disclosure.hidden.length,
  };
}

/**
 * One change of the list, read: the disclosure it is (a toggle, or a toggle's
 * reveal arriving), or none — and what is still awaited after it.
 */
function foldStep<T>({
  prevItems,
  nextItems,
  prevOpen,
  nextOpen,
  awaited,
  getKey,
  isStandIn,
}: {
  prevItems: readonly T[];
  nextItems: readonly T[];
  prevOpen: ReadonlySet<string> | undefined;
  nextOpen: ReadonlySet<string> | undefined;
  awaited: AwaitedReveal;
  getKey: (item: T, index: number) => string;
  isStandIn: IsStandIn<T>;
}): { disclosure: RowDisclosure<T> | null; awaited: AwaitedReveal } {
  if (
    prevOpen === undefined ||
    nextOpen === undefined ||
    prefersReducedMotion()
  )
    return { disclosure: null, awaited: NOTHING_AWAITED };
  if (sameKeys(prevOpen, nextOpen))
    return detectContinuation({
      prevItems,
      nextItems,
      awaited,
      getKey,
      isStandIn,
    });
  const toggled = detectDisclosure({
    prevItems,
    nextItems,
    prevOpen,
    nextOpen,
    getKey,
  });
  const fresh = awaitedReveal({
    nextItems,
    prevOpen,
    nextOpen,
    revealed: toggled?.revealed ?? new Set(),
    getKey,
    isStandIn,
  });
  // Earlier toggles still waiting keep waiting, unless this one closed them.
  return {
    disclosure: toggled,
    awaited: {
      after: new Set([
        ...[...awaited.after].filter((key) => nextOpen.has(key)),
        ...fresh.after,
      ]),
      standIns: new Set([...awaited.standIns, ...fresh.standIns]),
    },
  };
}

const NO_STAND_INS = (): boolean => false;

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Rows held at a fold's first frame through inline style, each restored to
 * the inline values it had (a sortable row's own `transform`) on release.
 */
class PinnedRows {
  private prior = new Map<
    HTMLElement,
    { transform: string; clipPath: string; opacity: string }
  >();

  pin(motions: RowMotion[]): void {
    for (const { el, from } of motions) {
      const { transform, clipPath, opacity } = el.style;
      this.prior.set(el, { transform, clipPath, opacity });
      const frame = rowKeyframe(from);
      el.style.transform = String(frame.transform);
      if (frame.clipPath !== undefined)
        el.style.clipPath = String(frame.clipPath);
      if (frame.opacity !== undefined) el.style.opacity = String(frame.opacity);
    }
  }

  release(): void {
    for (const [el, { transform, clipPath, opacity }] of this.prior) {
      el.style.transform = transform;
      el.style.clipPath = clipPath;
      el.style.opacity = opacity;
    }
    this.prior.clear();
  }
}
