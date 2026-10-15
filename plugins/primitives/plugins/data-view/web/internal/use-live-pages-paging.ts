import { useMemo } from "react";
import {
  useLive,
  type LivePagesQuery,
  type LivePagesResult,
} from "@plugins/network/plugins/live/web";
import type {
  LiveCollection,
  LivePagedValue,
  LiveValueOrigin,
} from "@plugins/network/plugins/live/core";
import type { DataViewPaging } from "../../core";
import { pagesPaging } from "./pages-paging";
import { usePagesViewport } from "./pages-viewport";

/** A paged read's paging, before a consumer says which of its rows are the read's. */
export type LivePagesPaging = Omit<DataViewPaging<unknown>, "isPaged">;

/**
 * Read a collection's window as live key-range pages for a DataView to
 * show: `pages` is `network/live`'s `useLive(c, query, { viewport })` read, and `paging` (once
 * it is `ready`, else `null`) is what the DataView showing its rows takes as
 * `paging` — whose `viewport` is where the DataView reports the rows it has
 * on screen, which `pages` keeps its pages live by. The viewport and the
 * paging are minted together here, so a read cannot page by a viewport
 * nothing measures: hand `paging` to the DataView drawing the rows (with
 * `isPaged` / `total` added as the consumer knows them).
 */
export function useLivePagesPaging<Row, F, S extends string>(
  collection: LiveCollection<Row, F, S> | null,
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

/**
 * `useLivePagesPaging`'s twin for a key-range-paged VALUE (`liveValue(key, {
 * query, paged })`, an external source's items): the same viewport-kept pages
 * and the same `paging`, so a DataView shows an external source at any depth
 * exactly as it shows a collection's window. Search and filter run in memory
 * over the rows loaded (a value has no filterable seam).
 */
export function useLivePagedValuePaging<
  Item,
  Meta,
  Q,
  QIn,
  C extends string = never,
>(
  value: LivePagedValue<Item, Meta, Q, QIn, LiveValueOrigin, C> | null,
  query: NoInfer<QIn> | null,
  options?: { resetKey?: string },
): { pages: LivePagesResult<Item, C>; paging: LivePagesPaging | null } {
  const { viewport, sink } = usePagesViewport();
  const resetKey = options?.resetKey;
  const pages = useLive(
    value,
    query,
    resetKey === undefined ? { viewport } : { viewport, resetKey },
  );
  const paging = useMemo((): LivePagesPaging | null => {
    switch (pages.status) {
      case "ready":
        return pagesPaging<unknown>(pages, sink);
      case "loading":
      case "error":
        return null;
    }
  }, [pages, sink]);
  return useMemo(() => ({ pages, paging }), [pages, paging]);
}
