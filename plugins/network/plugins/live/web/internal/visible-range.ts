import type { PageViewport } from "../../shared/page-plan";

declare const visibleRangeBrand: unique symbol;

/**
 * Which rows of a paged read are on screen — what `useLive(c, query, {
 * viewport })` keeps its pages live by. Keyed by row id: `measuring` (not known yet: liveness stays
 * as it is), `none` (no row of the read is on screen: every page releases),
 * or the first and last visible row in the read's order.
 *
 * BRANDED, and minted only by what measures a viewport — data-view's
 * `usePagesViewport`, which a DataView feeds from the rows it draws. A read
 * with no viewport to measure (a set reader, a count) cannot spell one: it
 * reads `useLive(c, query)`, every page live and capped at `maxLimit` rows.
 */
export type VisibleRange = PageViewport & {
  readonly [visibleRangeBrand]: true;
};

/**
 * Mint a {@link VisibleRange}. Called by data-view's viewport hook alone
 * (it measures the rows a DataView draws); anything else that reaches for it
 * is reading pages with no viewport behind them.
 */
export function mintVisibleRange(range: PageViewport): VisibleRange {
  return range as VisibleRange;
}
