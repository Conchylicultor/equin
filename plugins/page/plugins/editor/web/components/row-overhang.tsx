import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
  type RefObject,
} from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

import type { RowOverhang } from "../internal/selection-bands";

/**
 * How far a row's content paints past its column, told to the editor by the
 * content.
 *
 * The selection band is a SIBLING of the rows (`internal/selection-bands.ts`),
 * placed by numbers the editor computes — and for every ordinary line those
 * numbers are the column's, known without looking. A box that grows past its
 * column (`WideBlock`: its width is its content's, centered on the column) is
 * the one thing the editor cannot derive: only the box knows how wide it came
 * out. So the box measures how far it overhangs its column and reports it
 * here; the band of a run containing it grows by that much on each side, so it
 * surrounds the box with the margin it keeps around any content.
 *
 * Push-based: re-measured on a resize of the box or of the column it centers
 * on (`useResizeObserver`), withdrawn on unmount. Outside the editor's rows (a
 * read-only surface, which paints no selection) there is no sink and nothing is
 * measured.
 */
type ReportOverhang = (overhang: RowOverhang | null) => void;

const RowOverhangContext = createContext<ReportOverhang | null>(null);

/** Mounted by the editor's row cell: what a box inside reports lands on its row. */
export function RowOverhangProvider({
  blockId,
  onOverhang,
  children,
}: {
  blockId: string;
  /** Stable for the editor's lifetime. `null` withdraws the row's overhang. */
  onOverhang: (blockId: string, overhang: RowOverhang | null) => void;
  children: ReactNode;
}) {
  const report = useMemo<ReportOverhang>(
    () => (overhang) => onOverhang(blockId, overhang),
    [blockId, onOverhang],
  );
  return (
    <RowOverhangContext.Provider value={report}>
      {children}
    </RowOverhangContext.Provider>
  );
}

/**
 * Report how far `box` overhangs `column` — the element it sizes and centers
 * against — on each side, as its row's. `column`'s own width changes (a pane
 * resize, an indent) can move the box without resizing it, so both are
 * observed.
 */
export function useReportRowOverhang(
  column: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
): void {
  const report = useContext(RowOverhangContext);
  // Withdrawn in a LAYOUT cleanup declared before the measuring one, so a sink
  // change withdraws the old report before the new measure lands — a passive
  // cleanup would run after it and erase it.
  useLayoutEffect(() => (report ? () => report(null) : undefined), [report]);
  useResizeObserver(
    () =>
      report && column.current && box.current
        ? [column.current, box.current]
        : null,
    () => {
      const col = column.current;
      const el = box.current;
      if (!report || !col || !el) return;
      const c = col.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      report({
        left: Math.max(0, c.left - b.left),
        right: Math.max(0, b.right - c.right),
      });
    },
    { deps: [report] },
  );
}
