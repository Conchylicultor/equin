import type {
  LivePagesResult,
  PagesTruncation,
} from "@plugins/network/plugins/live/web";
import type {
  DataViewPagePlaceholders,
  DataViewPaging,
  DataViewViewportSink,
} from "../../core";

/** A settled paged read — the arm that has rows to page past. */
export type SettledPages = Extract<
  LivePagesResult<unknown>,
  { status: "ready" }
>;

/**
 * What a list that stopped short tells the user (the footer's line), per
 * reason — in its terms; the plan's own wording goes to its log.
 */
const TRUNCATION_HINT: Readonly<Record<PagesTruncation, string>> = {
  "long-sort-key":
    "the rest cannot be scrolled to in this sort — narrow the filter, or sort by another field",
};

/**
 * A settled `useLive` read as a DataView's {@link DataViewPaging}: the
 * failures paging stopped on become the footer's Retry (re-reading each of
 * them), the rest notices above the rows, its pages past the stale budget the
 * placeholders drawn before and after them, and `viewport` is where the DataView
 * reports the rows it has on screen — the sink of the `usePagesViewport` whose
 * `viewport` the read pages by. Called by `useLivePagesPaging` alone, which
 * mints the two together.
 */
export function pagesPaging<TRow>(
  pages: SettledPages,
  viewport: DataViewViewportSink,
): DataViewPaging<TRow> {
  const blocking = pages.pageErrors.filter((e) => e.blocksPaging);
  return {
    canGrow: pages.canGrow,
    growing: pages.growing,
    loadMore: pages.loadMore,
    complete: pages.exhausted,
    stalled:
      blocking.length === 0
        ? null
        : {
            retry: () => {
              for (const e of blocking) e.retry();
            },
          },
    truncated:
      pages.truncated === false
        ? false
        : { hint: TRUNCATION_HINT[pages.truncated.reason] },
    notices: pages.pageErrors
      .filter((e) => !e.blocksPaging)
      .map((e) => ({
        key: e.key,
        afterRowId: e.afterRowId,
        error: e.error,
        retry: e.retry,
      })),
    viewport,
    placeholders: pages.placeholders,
  };
}

/** A read with no page drawn as a placeholder (one bounded read, a section not read yet). */
export const NO_PLACEHOLDERS: DataViewPagePlaceholders = {
  before: [],
  after: [],
};
