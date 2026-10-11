import { useMemo } from "react";
import {
  useLive,
  type LivePagesQuery,
  type LivePagesResult,
} from "@plugins/network/plugins/live/web";
import type { LiveScrollCollection } from "@plugins/network/plugins/live/core";
import type { DataViewPaging } from "../../core";
import { pagesPaging } from "./pages-paging";
import { usePagesViewport } from "./pages-viewport";

/** A paged read's paging, before a consumer says which of its rows are the read's. */
export type LivePagesPaging = Omit<DataViewPaging<unknown>, "isPaged">;

/**
 * Read a `scroll: true` collection as live key-range pages for a DataView to
 * show: `pages` is `network/live`'s `useLive(c, query, { viewport })` read, and `paging` (once
 * it is `ready`, else `null`) is what the DataView showing its rows takes as
 * `paging` — whose `viewport` is where the DataView reports the rows it has
 * on screen, which `pages` keeps its pages live by. The viewport and the
 * paging are minted together here, so a read cannot page by a viewport
 * nothing measures: hand `paging` to the DataView drawing the rows (with
 * `isPaged` / `total` added as the consumer knows them).
 */
export function useLivePagesPaging<Row, F, S extends string>(
  collection: LiveScrollCollection<Row, F, S> | null,
  query: LivePagesQuery<F, S> | null,
  options?: { resetKey?: string },
): { pages: LivePagesResult<Row>; paging: LivePagesPaging | null } {
  const { viewport, sink } = usePagesViewport();
  const resetKey = options?.resetKey;
  const pages = useLive(
    collection,
    query,
    resetKey === undefined ? { viewport } : { viewport, resetKey },
  );
  const paging = useMemo((): LivePagesPaging | null => {
    switch (pages.status) {
      case "ready":
        return pagesPaging<unknown>(pages, sink);
      // Nothing to page yet: the DataView shows the read's own state.
      case "loading":
      case "error":
        return null;
    }
  }, [pages, sink]);
  return useMemo(() => ({ pages, paging }), [pages, paging]);
}
