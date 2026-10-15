import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultRangeExtractor,
  measureElement as measureRowElement,
  useVirtualizer,
  type Range,
  type Virtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { findScrollParent } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useRowFold } from "@plugins/primitives/plugins/virtual-rows/plugins/row-fold/web";

/** How far past its window a fold in flight draws (rows) — enough for any
 *  viewport's worth of rows sliding through, without drawing a whole subtree. */
const MAX_DRAW_PAST_END = 60;

export interface VirtualRowsProps<T> {
  items: readonly T[];
  /** Estimated px per row; dynamic measurement refines it after mount. */
  estimateSize: number;
  /** Rows rendered beyond the viewport on each side. Default 8. */
  overscan?: number;
  getKey: (item: T, index: number) => string;
  /** Applied to each absolute-positioned row wrapper (e.g. horizontal inset). */
  itemClassName?: ClassName;
  /** When set, scrolls the virtualizer to this index (align: auto — only when off-screen). For host-driven selection reveal. */
  scrollToIndex?: number | null;
  /**
   * Item keys that must stay rendered even when scrolled out of the window.
   * They render at their true measured offset (so they're invisible off-screen
   * but remain in the DOM). The use case is an in-progress @dnd-kit drag whose
   * source row would otherwise unmount mid-gesture — unregistering its
   * draggable and cancelling the drop. Keep it pinned for the drag's duration.
   */
  keepMounted?: readonly string[];
  /**
   * Item key whose wrapper is lifted onto the raised z-layer. Each wrapper is
   * transformed, so it is its own stacking context and nothing inside it can
   * paint over a later sibling wrapper; a row dragged across its neighbours
   * (sortable reorder) needs its wrapper raised instead. Pass the active drag
   * id while a drag is in flight, nothing otherwise.
   */
  raisedKey?: string;
  /**
   * The open disclosures `items` were flattened under (a tree's expanded ids)
   * — present, a change of `items` that comes with a flip here FOLDS: revealed
   * rows grow in, hidden ones fold out, the rows below slide (`row-fold`).
   * Absent: the list has no disclosures and every change lands as is.
   */
  openKeys?: ReadonlySet<string>;
  /** Lines drawn in place of rows not listed yet (a lazy node's placeholder):
   *  rows that later land in their place fold in (`useRowFold`). */
  isStandIn?: (item: T) => boolean;
  children: (item: T, index: number) => ReactNode;
}

export interface UseVirtualRowsOptions<T> {
  items: readonly T[];
  /**
   * Estimated px per row — one size for every row, or a per-index size for rows
   * whose heights are known up front (e.g. laid-out systems of a score). Dynamic
   * measurement refines it after mount.
   */
  estimateSize: number | ((index: number) => number);
  /** Rows rendered beyond the viewport on each side. Default 8. */
  overscan?: number;
  getKey: (item: T, index: number) => string;
  /** When set, scrolls the virtualizer to this index (align: auto — only when off-screen). */
  scrollToIndex?: number | null;
  /** Item keys that must stay rendered even when scrolled out of the window. */
  keepMounted?: readonly string[];
  /**
   * Rows drawn past the window's end on top of `overscan` — while a fold is
   * in flight, the rows it slides up through the viewport (or the ones it
   * pushes down out of it) must exist. Default 0.
   */
  drawPastEnd?: number;
}

export interface UseVirtualRowsResult {
  /** Attach to the element whose top marks the start of the virtual region;
   *  scrollMargin is measured from it. */
  measureRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLElement, Element>;
  virtualItems: VirtualItem[];
  totalSize: number;
  scrollMargin: number;
  /**
   * While the first row's real size is not known yet (the first commit, when
   * the window draws nothing — the virtualizer waits for its scroller): the
   * ref to put on one invisible render of `items[0]`, measured before paint
   * to become the estimate. `null` otherwise (render no probe).
   */
  probe: ((el: Element | null) => void) | null;
}

/**
 * The boxes whose size decides where `sizer` sits in `scroller`: every
 * ancestor below the scroller (a box above the region growing inside one
 * grows it) and every element laid out before the sizer at each of those
 * levels (one growing at a level whose box cannot grow — the scroller's own
 * children, a fixed-height container). A `display: contents` element draws
 * no box, so its children stand for it.
 */
function boxesAbove(sizer: Element, scroller: Element): Element[] {
  const out: Element[] = [];
  const addBox = (el: Element) => {
    if (getComputedStyle(el).display !== "contents") {
      out.push(el);
      return;
    }
    for (const child of el.children) addBox(child);
  };
  for (
    let node: Element = sizer, parent = node.parentElement;
    node !== scroller && parent !== null;
    node = parent, parent = node.parentElement
  ) {
    for (
      let before = node.previousElementSibling;
      before !== null;
      before = before.previousElementSibling
    ) {
      addBox(before);
    }
    if (parent !== scroller) out.push(parent);
  }
  return out;
}

/**
 * Headless windowing engine shared by `VirtualRows` and the data-table body.
 * Discovers the scroll container at runtime (`findScrollParent`) rather than
 * threading it in, so windowing works whether the consumer owns its scroll
 * (surface mode) or is embedded inside a larger scroller. When the region does
 * not start at the top of that scroller (a toolbar / tab strip sits above it),
 * `scrollMargin` offsets the windowing by the measured gap.
 */
export function useVirtualRows<T>({
  items,
  estimateSize,
  overscan = 8,
  getKey,
  scrollToIndex,
  keepMounted,
  drawPastEnd = 0,
}: UseVirtualRowsOptions<T>): UseVirtualRowsResult {
  "use no memo";
  // "use no memo" -- @tanstack/react-virtual returns a mutable Virtualizer whose state mutates outside React's render cycle (incompatible-library); compiling it risks stale windowed rows.
  const measureRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // The first commit renders no window (the virtualizer waits for its
  // scroller), so the caller renders one invisible probe of a real row
  // instead (`probe`), measured here before paint: the window's first
  // estimate is the height rows really have under the current theme, not a
  // constant. A wrong one misplaces every not-yet-measured row above the
  // viewport — a list that becomes windowed while scrolled (a tree opening a
  // big folder, a table growing past its windowing threshold) would shift
  // its visible rows by the accumulated error.
  const probeRef = useRef<Element | null>(null);
  const setProbe = useCallback((el: Element | null) => {
    probeRef.current = el;
  }, []);
  const [probedSize, setProbedSize] = useState<number | null>(null);
  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (probe === null) return;
    const height = probe.getBoundingClientRect().height;
    if (height > 0) setProbedSize(height);
  }, []);
  // The size the first row measured had — the estimate for every row not
  // measured yet (see `estimateSize` below). A box, not state: it is read by
  // the virtualizer, never rendered.
  const [learnedSize] = useState<{ size: number | null }>(() => ({
    size: null,
  }));
  // The items `scrollMargin` was last measured with (see the adjustment gate
  // below the virtualizer).
  const [marginItems, setMarginItems] = useState<readonly T[] | null>(null);

  // Indexes of the pinned (keepMounted) items. Empty (cheap early-out) whenever
  // nothing is pinned, which is the common, non-dragging case.
  const pinnedIndexes = useMemo(() => {
    if (!keepMounted || keepMounted.length === 0) return [];
    const want = new Set(keepMounted);
    const out: number[] = [];
    items.forEach((item, i) => {
      if (want.has(getKey(item, i))) out.push(i);
    });
    return out;
  }, [keepMounted, items, getKey]);

  // Force the pinned indexes into the rendered range on top of the windowed
  // range, so a pinned row stays mounted (at its real offset) even far outside
  // the viewport.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const base = defaultRangeExtractor(
        drawPastEnd === 0
          ? range
          : {
              ...range,
              endIndex: Math.min(range.count - 1, range.endIndex + drawPastEnd),
            },
      );
      if (pinnedIndexes.length === 0) return base;
      const set = new Set(base);
      for (const i of pinnedIndexes) {
        if (i >= 0 && i < items.length) set.add(i);
      }
      return [...set].sort((a, b) => a - b);
    },
    [pinnedIndexes, items.length, drawPastEnd],
  );

  // Resolve the scroll container and the region's offset within it once mounted
  // (refs are attached by layout-effect time). A layout effect runs before
  // paint, so the windowed rows appear without a blank frame.
  useLayoutEffect(() => {
    const sizer = measureRef.current;
    if (!sizer) return;
    const parent = findScrollParent(sizer);
    setScrollEl(parent);
    setScrollMargin(
      sizer.getBoundingClientRect().top -
        parent.getBoundingClientRect().top +
        parent.scrollTop,
    );
  }, []);

  // The region's offset moves whenever content ABOVE it changes height — with
  // the rows (a paged list's far pages swapped for a placeholder before it,
  // or back) or without them (another section's placeholders above this
  // one). So it is re-measured in the commit that changes the items (the
  // observer's synchronous measure on re-subscribe) and whenever a box that
  // decides it resizes (see
  // `boxesAbove`), and the window keeps tracking the rows it draws rather
  // than where they started. The boxes are re-collected with the items: what
  // sits above the region changes with what is drawn.
  useResizeObserver(
    () => {
      const sizer = measureRef.current;
      return sizer === null || scrollEl === null
        ? null
        : boxesAbove(sizer, scrollEl);
    },
    () => {
      const sizer = measureRef.current;
      if (!sizer || scrollEl === null) return;
      const margin =
        sizer.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop;
      setScrollMargin((prev) => (prev === margin ? prev : margin));
      setMarginItems(items);
    },
    { deps: [items, scrollEl] },
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- @tanstack/react-virtual is genuinely compiler-incompatible (returns a mutable Virtualizer mutated outside render); this hook is the sanctioned exempt, opted out of compilation via the "use no memo" directive above.
  const virtualizer = useVirtualizer({
    count: items.length,
    // Off until the scroller is known. The virtualizer WRITES its initial offset
    // to the scroller the moment it attaches, and caches that offset the first
    // time it renders enabled — so it must not render enabled before it can
    // read where the scroller already is. Otherwise a list that becomes
    // windowed inside an already-scrolled container (a tree opening a folder
    // past its windowing threshold) is thrown back to the top.
    enabled: scrollEl !== null,
    getScrollElement: () => scrollEl,
    initialOffset: () => scrollEl?.scrollTop ?? 0,
    // One size for every row: the size the first row measured turned out to
    // have, once one did — `estimateSize` is only a first guess (the table's
    // constant). A wrong estimate is paid every time the window reaches a
    // row it never drew: the rows below it shift by the difference, and one
    // first drawn above the reader (a step longer than the overscan) has the
    // virtualizer scroll by the difference — the reader sees the list jolt
    // by it, a row at a time (measured: 5 px per row, a 36 px guess for 31 px
    // table rows, tens of px per step).
    estimateSize:
      typeof estimateSize === "number"
        ? () => learnedSize.size ?? probedSize ?? estimateSize
        : estimateSize,
    measureElement: (el, entry, instance) => {
      const size = measureRowElement(el, entry, instance);
      if (learnedSize.size === null && size > 0) learnedSize.size = size;
      return size;
    },
    overscan,
    getItemKey: (index) => getKey(items[index]!, index),
    rangeExtractor,
    scrollMargin,
  });

  // The commit that changes the items renders the window against the margin
  // measured for the OLD items — the margin is re-measured in that commit's
  // layout phase, after the rows it drew were measured. When content above
  // changed with the items (a page of rows above released into a
  // placeholder), that window is a page away from the viewport, and its rows,
  // measured for the first time, sit "above the scroll offset" by the
  // stale numbers: the virtualizer would scroll to compensate for rows that
  // are not above the reader at all — from its own cached offset, which a
  // scroll not yet reported to it makes the offset BEFORE that scroll, so it
  // scrolled the reader back by the whole step (−700 px, measured). Until
  // the margin is measured for the items drawn, a size it learns adjusts
  // nothing; the window is redrawn at the true margin before paint.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    marginItems === items ? undefined : () => false;

  useEffect(() => {
    if (scrollEl === null || scrollToIndex == null || scrollToIndex < 0) return;
    virtualizer.scrollToIndex(scrollToIndex, { align: "auto" });
  }, [scrollEl, scrollToIndex, virtualizer]);

  // While disabled the virtualizer measures nothing (total size 0); hold the
  // sizer at its estimated extent so the content never collapses — a collapse
  // would clamp the scroller's position before the virtualizer can read it.
  const totalSize =
    scrollEl === null
      ? typeof estimateSize === "number"
        ? items.length * (probedSize ?? estimateSize)
        : items.reduce<number>((sum, _, i) => sum + estimateSize(i), 0)
      : virtualizer.getTotalSize();

  return {
    measureRef,
    virtualizer,
    virtualItems: virtualizer.getVirtualItems(),
    totalSize,
    scrollMargin,
    probe:
      typeof estimateSize === "number" &&
      probedSize === null &&
      items.length > 0
        ? setProbe
        : null,
  };
}

/**
 * Windowed renderer shared by data-view's flat views. Renders only the rows
 * intersecting the host's scroll viewport (+overscan) inside a full-height
 * sizer, so a large data source stays cheap to render and scroll. Rows are
 * dynamically measured (variable heights supported).
 *
 * The scroll element is discovered at runtime (`findScrollParent`) rather than
 * threaded in, so the same component windows correctly whether the data-view
 * owns its scroll (surface mode) or is embedded inside a larger scroller. When
 * the list does not start at the top of that scroller (a toolbar / tab strip
 * sits above it), `scrollMargin` offsets the windowing by the measured gap.
 */
export function VirtualRows<T>({
  items,
  estimateSize,
  overscan = 8,
  getKey,
  itemClassName,
  scrollToIndex,
  keepMounted,
  raisedKey,
  openKeys,
  isStandIn,
  children,
}: VirtualRowsProps<T>): ReactNode {
  const fold = useRowFold({ items, getKey, openKeys, isStandIn });
  const drawn = fold.items;
  const {
    measureRef,
    virtualizer,
    virtualItems,
    scrollMargin,
    totalSize,
    probe,
  } = useVirtualRows({
    items: drawn,
    estimateSize,
    overscan,
    getKey,
    scrollToIndex,
    keepMounted,
    drawPastEnd: Math.min(fold.inFlight, MAX_DRAW_PAST_END),
  });

  return (
    // The windowing sizer: a `relative` positioning host whose height is the full
    // virtual extent, anchoring each row at a measured translateY offset. No
    // suppression needed — `no-adhoc-layout` deliberately leaves positioning
    // CONTEXT (`relative`/`static`) and sizing (`w-full`) alone.
    <div
      ref={measureRef}
      {...fold.hostProps}
      className="relative w-full"
      style={{ height: totalSize }}
    >
      {probe !== null && virtualItems.length === 0 && (
        <Placed
          ref={probe}
          aria-hidden
          inert
          x={{ start: 0, end: 0 }}
          y={{ start: 0 }}
          className={cn(itemClassName, "invisible")}
        >
          {children(drawn[0]!, 0)}
        </Placed>
      )}
      {virtualItems.map((vi) => (
        // Each windowed row spans the sizer's width and is composited down to
        // its measured offset. The two axes are different mechanics on purpose:
        // x is a plain inset, and only y is a `shift`, so the offset stays on
        // the compositor while the row still stretches to the sizer. A fold
        // moves the row with `transform`, which composes with that `translate`.
        <Placed
          key={vi.key}
          {...fold.rowProps(String(vi.key))}
          data-index={vi.index}
          ref={virtualizer.measureElement}
          x={{ start: 0, end: 0 }}
          y={{ start: 0, shift: vi.start - scrollMargin }}
          layer={vi.key === raisedKey ? "raised" : undefined}
          className={itemClassName}
        >
          {children(drawn[vi.index]!, vi.index)}
        </Placed>
      ))}
    </div>
  );
}
