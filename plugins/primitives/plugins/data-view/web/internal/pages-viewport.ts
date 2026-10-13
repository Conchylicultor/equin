import { useMemo, useState } from "react";
import {
  mintVisibleRange,
  type VisibleRange,
} from "@plugins/network/plugins/live/web";
import type { DataViewViewportSink, DataViewVisibleRows } from "../../core";

/**
 * The viewport a paged read pages by, measured by a DataView: `viewport` is
 * what `useLive` takes, `sink` is what the read's paging hands the
 * DataView (`DataViewPaging.viewport`) to report the rows it has on screen.
 * `measuring` until the first report, so nothing is released before the rows
 * were ever drawn. The only place a `VisibleRange` is minted (the
 * `live/visible-range-minter` lint), used by `useLivePagesPaging` alone, which
 * hands the sink out inside the paging the DataView takes: a read can page
 * only by a viewport something measures.
 */
export function usePagesViewport(): {
  viewport: VisibleRange;
  sink: DataViewViewportSink;
} {
  // Minted lazily, never at module load: a test that hand-mocks the live
  // barrel (without `mintVisibleRange`) must still import data-view.
  const [viewport, setViewport] = useState<VisibleRange>(() =>
    mintVisibleRange({ kind: "measuring" }),
  );
  const sink = useMemo(
    (): DataViewViewportSink => ({
      report: (rows: DataViewVisibleRows) =>
        setViewport((prev) =>
          sameRows(prev, rows) ? prev : mintVisibleRange(rows),
        ),
    }),
    [],
  );
  return { viewport, sink };
}

function sameRows(a: VisibleRange, b: DataViewVisibleRows): boolean {
  if (a.kind !== b.kind) return false;
  return (
    a.kind !== "rows" ||
    b.kind !== "rows" ||
    (a.first === b.first && a.last === b.last)
  );
}

/** A sink for a paging that pages by no viewport (one bounded read, a section not read yet). */
export const NO_VIEWPORT: DataViewViewportSink = { report: () => {} };
