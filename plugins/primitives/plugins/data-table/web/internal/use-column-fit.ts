import { useMemo, useRef, useState } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useScrollsSideways } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { fitAlignedColumns, floorAtLabel, trackMin } from "../../core";
import type { ColumnDef } from "./types";

/** The narrowest the first column of a NESTED table gets before a column gives
 *  way — the tree's own label floor, so a deep row keeps a readable name. */
export const NESTED_LEAD_MIN_PX = 160;

/** What the fit reads off the laid-out table, once per resize. */
interface Room {
  /** What the grid can have before it overflows: its box, but never past the
   *  scroller's visible right edge (a wide table grows the boxes around it). */
  available: number;
  /** A row's inline padding (the rail). */
  pad: number;
  /** The grid's column gap. */
  gap: number;
  /** The reserved trailing actions track. */
  actions: number;
  /** The grid's own laid-out width — wider than `available` when it overflows. */
  grid: number;
  /** One `rem` in px, for a track spelled in rem. */
  rem: number;
  /** The measured minimum of every content-sized column seen so far, by id. */
  measured: ReadonlyMap<string, number>;
}

/**
 * What the fit may do. `wide`: drop columns, then overflow sideways with the
 * first column pinned (a grid table in a sideways-scroll region). `drop`: drop
 * columns, never overflow (an outline with its column labels — its box is a
 * sidebar's or a listing's, which does not scroll sideways). `none`: every
 * column shows and squeezes (an outline without labels, a table in a card).
 */
export type ColumnFitMode = "wide" | "drop" | "none";

export interface ColumnFit<TRow> {
  /**
   * The table goes wide: `enabled` (a grid table in a `SidewaysScroll`
   * region), and the nearest ancestor clipping it horizontally is that
   * region's `Scroll` (`data-scroll-x-host`) — not some ad-hoc clipping box in
   * between. Only then does it pin its first column, fit its columns and
   * overflow; otherwise it squeezes into its box as it always did.
   */
  wide: boolean;
  /** The columns that fit, in their own order. */
  shown: ColumnDef<TRow>[];
  /** Each shown column's grid track (`floorAtLabel` once measured). */
  tracks: string[];
  containerRef: (el: HTMLElement | null) => void;
  gridRef: (el: HTMLElement | null) => void;
}

/**
 * Which columns a grid table shows in the room it has, and whether it still
 * overflows. A column whose field declares `dropOrder` gives way — lowest
 * first (`fitAlignedColumns`) —
 * until the first column keeps its minimum; a column with none never does, so
 * what is left scrolls sideways (the last resort).
 *
 * A column's minimum is its grid track's (`trackMin`): a length is itself,
 * `minmax(a, b)` is `a`. A content- or space-sized track is measured once, on
 * its header label (nowrap, so it is the narrowest the grid lets that track be
 * — the grid's `min-width: min-content` says the same thing in CSS), while the
 * column is shown, and cached by column id: a dropped column has no header left
 * to measure, so the cache is what tells the fit when it fits again. The room
 * is the same whatever subset shows, so the fit settles in one step.
 *
 * Until measured — and in a box with no layout (jsdom) — every column shows.
 */
export function useColumnFit<TRow>(
  columns: ColumnDef<TRow>[],
  opts: { mode: ColumnFitMode; nested: boolean; hasActionsTrack: boolean },
): ColumnFit<TRow> {
  const { mode, nested, hasActionsTrack } = opts;
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [grid, setGrid] = useState<HTMLElement | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  // Measured once per column id and kept while the column is dropped — the
  // fit needs it to know when the column fits again.
  const measured = useRef(new Map<string, number>());
  const columnIds = columns.map((c) => c.id).join("\u0000");

  useResizeObserver(
    // The scroller too: once the table overflows, its own box no longer
    // follows the pane, so a wider pane must still re-fit.
    () =>
      [container, grid, container && scrollerOf(container)].filter(
        (el): el is HTMLElement => !!el,
      ),
    () => {
      if (!container || !grid) return;
      // A table no scroll host can scroll sideways never goes wide.
      if (mode === "none" || (mode === "wide" && !sidewaysHost(container))) {
        setRoom(null);
        return;
      }
      const box = container.getBoundingClientRect();
      // A box with no layout says nothing about the room: every column stays.
      if (box.width === 0) return;
      // While the table overflows, the boxes around it grow to it (the
      // DataView root fits the table, so its band can pin), and so does this
      // one: the room is what the scroller shows to the right of the box's
      // start, whichever is narrower.
      const scroller = mode === "wide" ? scrollerOf(container) : null;
      // Both edges in the scroller's UNSCROLLED frame: a sideways scroll
      // moves the box, not the room.
      const visible = scroller
        ? scroller.getBoundingClientRect().left +
          scroller.clientLeft +
          scroller.clientWidth -
          (box.left + scroller.scrollLeft)
        : box.width;
      const available = Math.min(box.width, visible);
      const header = grid.querySelector<HTMLElement>(
        "[data-slot='data-table-header']",
      );
      if (!header) return;
      for (const cell of header.querySelectorAll<HTMLElement>(
        "[data-column-id]",
      )) {
        const id = cell.dataset.columnId!;
        if (measured.current.has(id)) continue;
        // The label's own inline box: its width is the label's, whatever
        // the track does.
        measured.current.set(id, Math.ceil(cell.getBoundingClientRect().width));
      }
      const headerStyle = getComputedStyle(header);
      const gridStyle = getComputedStyle(grid);
      const tracks = gridStyle.gridTemplateColumns.split(" ").map(parseFloat);
      const next: Room = {
        available,
        // The header row's inset: padding, and margin (an outline row sits
        // on the rail by its margin).
        pad:
          parseFloat(headerStyle.paddingLeft) +
          parseFloat(headerStyle.paddingRight) +
          parseFloat(headerStyle.marginLeft) +
          parseFloat(headerStyle.marginRight),
        gap: parseFloat(gridStyle.columnGap) || 0,
        actions: hasActionsTrack ? (tracks[tracks.length - 1] ?? 0) : 0,
        grid: grid.getBoundingClientRect().width,
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
        measured: new Map(measured.current),
      };
      setRoom((prev) =>
        prev &&
        prev.available === next.available &&
        prev.pad === next.pad &&
        prev.gap === next.gap &&
        prev.actions === next.actions &&
        prev.grid === next.grid &&
        prev.rem === next.rem &&
        prev.measured.size === next.measured.size
          ? prev
          : next,
      );
    },
    { deps: [container, grid, mode, hasActionsTrack, columnIds] },
  );

  const shown = useMemo(() => {
    if (!room || columns.length < 2) return columns;
    const minOf = (col: ColumnDef<TRow>): number => {
      const t = trackMin(col.width, room.rem);
      return t.kind === "px" ? t.px : (room.measured.get(col.id) ?? 0);
    };
    const [lead, ...rest] = columns;
    const droppable = rest.filter((c) => c.dropOrder !== undefined);
    const fixed = rest.filter((c) => c.dropOrder === undefined);
    const budget =
      room.available -
      room.pad -
      (hasActionsTrack ? room.actions + room.gap : 0) -
      fixed.reduce((sum, c) => sum + minOf(c) + room.gap, 0);
    const kept = new Set(
      fitAlignedColumns(
        droppable.map((col) => ({
          col,
          px: minOf(col),
          dropOrder: col.dropOrder,
        })),
        {
          budget,
          gap: room.gap,
          minLabel: Math.max(minOf(lead!), nested ? NESTED_LEAD_MIN_PX : 0),
        },
      ).map((c) => c.col),
    );
    return columns.filter((c) => c.dropOrder === undefined || kept.has(c));
  }, [room, columns, nested, hasActionsTrack]);

  // Only a wide table floors its tracks at their labels: that is what lets it
  // overflow rather than collapse a column. A dropping table squeezes what is
  // left, as it always did.
  const wideRoom = mode === "wide" ? room : null;
  const tracks = shown.map((col) =>
    wideRoom
      ? floorAtLabel(col.width, wideRoom.measured.get(col.id))
      : (col.width ?? "auto"),
  );

  const overflowing = !!wideRoom && wideRoom.grid > wideRoom.available + 0.5;
  // While the grid is wider, its box marks itself and the path up to the
  // scroller: the `Scroll` then scrolls sideways too (and only then), so the
  // pane is the one scroller on both axes and the sticky header and first
  // column pin to the same edges.
  useScrollsSideways(container, overflowing);

  return {
    wide: wideRoom !== null,
    shown,
    tracks,
    containerRef: setContainer,
    gridRef: setGrid,
  };
}

/**
 * Whether the table sits in a box that may scroll it sideways: the nearest
 * ancestor that clips it horizontally is a scroll host (`Scroll` marks itself
 * `data-scroll-x-host`). A DOM walk, not a React context, because a context
 * crosses portals: a table in a popover opened from a pane is in the pane's
 * React tree but in the popover's box, which must keep it squeezing.
 */
function sidewaysHost(el: HTMLElement): boolean {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (getComputedStyle(n).overflowX !== "visible") {
      return n.hasAttribute("data-scroll-x-host");
    }
  }
  return false;
}

/** The nearest ancestor that scrolls vertically — the pane, which also scrolls
 *  sideways while a table overflows it (`Scroll`'s `data-scrolls-x` arm). */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const y = getComputedStyle(n).overflowY;
    if (y === "auto" || y === "scroll") return n;
  }
  return null;
}
