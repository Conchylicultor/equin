import { useMemo } from "react";
import {
  useLive,
  type LivePagesQuery,
  type LivePagesResult,
} from "@plugins/network/plugins/live/web";
import type {
  LiveCollection,
  LiveCountedCollection,
  LivePagedValue,
  LiveValueOrigin,
  LiveWhere,
} from "@plugins/network/plugins/live/core";
import type { Filter } from "@plugins/network/plugins/live/plugins/filter/core";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { DataViewPaging, ViewState } from "../../core";
import { narrowWhere, usePagesNarrowing } from "./narrow-pages";
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
 *
 * - `narrowBy` — the view the rows are shown under (a merged surface's
 *   `DataViewSourceProps.view`), for rows filtered IN MEMORY: its filter is
 *   ANDed into `query` as far as the collection's columns can run it
 *   (`usePagesNarrowing`), so each page holds rows the view shows and the
 *   next page — which waits on the read's tail being on screen — keeps
 *   coming. Without it a filter hiding the tail stops the read at its first
 *   page.
 * - `total` — also read how many rows the (narrowed) query matches, as
 *   `paging.total` (`underFilter` when the narrowing is the view's whole
 *   filter); the collection must be declared `count: true`.
 */
export function useLivePagesPaging<Row, F, S extends string>(
  collection: LiveCollection<Row, F, S> | null,
  query: LivePagesQuery<F, S> | null,
  options?: { resetKey?: string; narrowBy?: ViewState; total?: true },
): { pages: LivePagesResult<Row>; paging: LivePagesPaging | null } {
  const { viewport, sink } = usePagesViewport();
  const narrowing = usePagesNarrowing(collection, options?.narrowBy);
  const narrowed = useMemo((): LivePagesQuery<F, S> | null => {
    if (query === null || narrowing.kind === "none") return query;
    const columns = [...(query.columns ?? []), ...narrowing.columns];
    return {
      ...query,
      where: narrowWhere(
        query.where as Filter | undefined,
        narrowing,
      ) as LiveWhere<F>,
      ...(columns.length > 0 ? { columns } : {}),
    };
  }, [query, narrowing]);
  // A narrowing change starts the read over, like any other query change.
  const resetKey =
    narrowing.kind === "none"
      ? options?.resetKey
      : JSON.stringify([options?.resetKey ?? null, narrowing.where]);
  const pages = useLive(
    collection,
    narrowed,
    resetKey === undefined ? { viewport } : { viewport, resetKey },
  );
  const counting = options?.total === true && narrowed !== null;
  const total = useLive(
    counting
      ? (collection as unknown as LiveCountedCollection<Row, F, S> | null)
      : null,
    !counting || narrowed === null
      ? null
      : {
          count: true,
          ...(narrowed.where !== undefined ? { where: narrowed.where } : {}),
          ...(narrowed.columns !== undefined
            ? { columns: narrowed.columns }
            : {}),
        },
  );
  // Not known yet, or failed with nothing seen: no total — the counts stay
  // lower bounds, which are still true (the failure is the read's to report).
  const totalCount = foldResource(total, {
    ready: (n) => n,
    loading: () => null,
    error: (_error, stale) => stale ?? null,
  });
  const underFilter = narrowing.kind === "narrowed" && narrowing.whole;
  const paging = useMemo((): LivePagesPaging | null => {
    switch (pages.status) {
      case "ready": {
        const paging = pagesPaging<unknown>(pages, sink);
        return options?.total === true
          ? {
              ...paging,
              total:
                totalCount === null
                  ? null
                  : {
                      count: totalCount,
                      ...(underFilter ? { underFilter } : {}),
                    },
            }
          : paging;
      }
      // Nothing to page yet: the DataView shows the read's own state.
      case "loading":
      case "error":
        return null;
    }
  }, [pages, sink, options?.total, totalCount, underFilter]);
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
