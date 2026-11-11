import {
  createContext,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * How the bar reads a width.
 *
 * `getBoundingClientRect().width`, never `offsetWidth`: the integer-rounding
 * loops this primitive replaces under-reported by up to 1px per item, which is
 * exactly how a row ends up permanently one pixel too wide and one item too
 * narrow.
 */
export type MeasureWidth = (el: Element) => number;

const domMeasureWidth: MeasureWidth = (el) => el.getBoundingClientRect().width;

/**
 * Does this element generate a box at all?
 *
 * NOT "is it visible", and the difference is the whole point. An element in a
 * `display: none` subtree generates no boxes, so it was never given a width and
 * there is no reading to have — which is a different fact from a rendered box
 * that measures zero, and the two are what the `no-slack` 0px branch has to
 * tell apart.
 *
 * `getClientRects()` because it is already this file's neighbour's spelling for
 * the same question: `measureRowOverflow` in `adaptive-bar.tsx` filters out
 * elements generating NO boxes with the identical predicate, and a second
 * spelling for one question is precisely the drift this primitive's docs spend
 * paragraphs preventing. It also beats every alternative. `offsetParent` is an
 * ancestor comparison the bar bans elsewhere and is `null` for the
 * `fixed`-positioned solo placement. `isConnected` answers about the document,
 * not about layout. `checkVisibility()` is newer than the WebKit `tauri/` ships
 * and folds in `content-visibility`, whose skipped subtree still has a real
 * width from its host.
 *
 * `visibility: hidden` deliberately still counts as rendered, and so still
 * faults: it changes nothing about layout, so the width the row reads there is
 * a width its host genuinely gave it.
 */
export type IsRendered = (el: Element) => boolean;

const domIsRendered: IsRendered = (el) => el.getClientRects().length > 0;

/** Everything the bar asks the layout engine, read for one decision. */
export interface MeasureBundle {
  measure: MeasureWidth;
  isRendered: IsRendered;
}

/**
 * The production bundle, frozen at module level so `useLayoutMeasured` can
 * identify it by reference — the same trick as before, one level up.
 */
const DOM_MEASURE: MeasureBundle = {
  measure: domMeasureWidth,
  isRendered: domIsRendered,
};

/**
 * Module level, NOT an inline default: the provider memoises its bundle on
 * `[measure, isRendered]`, and a fresh `() => true` per render would move that
 * dep on every render of every test that does not pass one.
 */
const alwaysRendered: IsRendered = () => true;

/**
 * The measurement seam.
 *
 * There is one legitimate reason to replace it and it is not configurability:
 * **jsdom has no layout engine**, so every rect is zero and the shared
 * `ResizeObserver` stub is inert. Without a seam the fit math — the part with
 * the interesting failure modes — would be reachable only through a real
 * browser, and the browser suite is a geometry gate, not a place to assert that
 * a widget kept its React identity across a re-parent.
 *
 * So a test supplies widths and drives the same code path the browser drives.
 * Nothing else may use this: a consumer that "adjusts" measurement is lying to
 * the layout engine about a number the layout engine owns.
 */
const MeasureContext = createContext<MeasureBundle>(DOM_MEASURE);

/**
 * One context read for both answers, because they are read at the same instant
 * for the same decision — the argument {@link readRowMetrics} makes for reading
 * gap and inset together.
 */
export function useMeasureBundle(): MeasureBundle {
  return useContext(MeasureContext);
}

/**
 * Are the widths coming from a real layout engine?
 *
 * The bar's two placement guards — "you were given no slack" and "you
 * overshot" — are assertions ABOUT the layout engine: they compare what the fit
 * math believed against what the engine actually did. With the seam replaced
 * there is no engine to contradict, and jsdom happily reports `flex-grow: 0` for
 * every element because nothing applied a stylesheet — so running the guards
 * there would fail every test on a fact about jsdom rather than about the bar.
 */
export function useLayoutMeasured(): boolean {
  return useContext(MeasureContext) === DOM_MEASURE;
}

/**
 * Test-only. See {@link MeasureWidth}.
 *
 * `isRendered` defaults to `() => true` precisely so the `no-slack` 0px branch
 * stays drivable from jsdom: jsdom returns `[]` from `getClientRects()` for
 * every element, so the real predicate would answer "not rendered" everywhere
 * and quietly make that branch dead code in the one suite that can reach it.
 * A supplied width is by definition a width something gave the row, so a test
 * that says nothing about rendered-ness means "rendered".
 */
export function AdaptiveBarMeasure({
  measure,
  isRendered = alwaysRendered,
  children,
}: {
  measure: MeasureWidth;
  isRendered?: IsRendered;
  children: ReactNode;
}): ReactElement {
  const bundle = useMemo(
    () => ({ measure, isRendered }),
    [measure, isRendered],
  );
  return (
    <MeasureContext.Provider value={bundle}>{children}</MeasureContext.Provider>
  );
}

/** What the row's own computed style says about the space it has to give. */
export interface RowMetrics {
  /**
   * The gap between two adjacent occupants, read from the RENDERED element
   * rather than from the `gap` prop it was built from.
   *
   * The prop names a role on the density ramp; the pixels it resolves to depend
   * on the active density preset, which changes at runtime. Re-deriving the
   * number from the role would be a second source of truth that silently
   * desyncs the moment a preset changes — the `MORE_BTN_W = 32` mistake in a
   * different costume.
   */
  gapPx: number;
  /**
   * Horizontal padding + border: the part of the row's border box that its
   * occupants are NOT laid out in.
   *
   * The fit's budget has to be the CONTENT box, because that is the box the
   * occupants are laid out in and the box `measureRowOverflow` compares them
   * against. Reading `getBoundingClientRect().width` and stopping there gave the
   * fit a budget one padding wider than the room that exists, so a consumer
   * adding padding to a bar root would produce a row the fit blessed and the
   * engine overflowed — a `row-overflow` fault caused by the guard's own
   * arithmetic rather than by the layout.
   *
   * That was invisible while occupants could be squeezed: flex absorbed the
   * difference, the spans summed to the content box, and the guard measured no
   * overflow however much padding the root carried.
   */
  insetPx: number;
}

/**
 * The row's gap and its horizontal inset, from ONE computed-style read.
 *
 * Together rather than separately because they are read at the same instant for
 * the same decision, and a second `getComputedStyle` is a second chance for the
 * two to describe different layouts.
 *
 * A non-numeric answer (`"normal"`, or jsdom's empty string) is not a length, so
 * it contributes nothing rather than a `NaN` that would poison every sum.
 */
export function readRowMetrics(el: Element): RowMetrics {
  const style = getComputedStyle(el);
  return {
    gapPx: lengthPx(style.columnGap),
    insetPx:
      lengthPx(style.paddingLeft) +
      lengthPx(style.paddingRight) +
      lengthPx(style.borderLeftWidth) +
      lengthPx(style.borderRightWidth),
  };
}

function lengthPx(raw: string): number {
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) ? px : 0;
}

/**
 * How many of the row's laid-out flex items are NOT the bar's own — a host's
 * `Fill`, the growing `AdaptiveBar.Yield` cell, a reorder spacer.
 *
 * Each one costs the row a `gap` the fit never sees. Its WIDTH is slack (every
 * such cell is `min-w-0` and gives down to nothing, the yield cell's floor
 * reserved separately), but the gap beside it is not: flex lays out one gap
 * between every pair of items, so a row holding a `Fill` between its title box
 * and its `⋯` is one gap wider at its tightest than the fit's sum. Uncounted,
 * the fit blesses a placement inside that gap, the row overflows it, and the
 * `row-overflow` guard floors the whole bar over a few pixels (a canvas frame
 * header lost its title box into the `⋯` that way).
 *
 * `own` is what the fit already prices: the docked occupant containers and the
 * trigger. A flex item holding one of them (a host wrapper the anchor sits in)
 * is theirs, not foreign. `display: contents` boxes are walked through, since
 * their children are the row's flex items; out-of-flow children take no gap.
 *
 * Asks the real layout engine (`getClientRects`, computed style), so it is only
 * called where {@link useLayoutMeasured} holds — the same gate as the guard it
 * keeps honest.
 */
export function foreignCellCount(
  root: Element,
  own: readonly Element[],
): number {
  let count = 0;
  const walk = (parent: Element): void => {
    for (const child of parent.children) {
      const style = getComputedStyle(child);
      if (style.display === "contents") {
        walk(child);
        continue;
      }
      if (child.getClientRects().length === 0) continue;
      if (style.position === "absolute" || style.position === "fixed") {
        continue;
      }
      if (own.some((el) => child === el || child.contains(el))) continue;
      count += 1;
    }
  };
  walk(root);
  return count;
}
