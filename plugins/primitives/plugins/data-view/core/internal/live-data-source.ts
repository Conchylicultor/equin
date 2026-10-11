import type {
  Filter,
  FilterColumn,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveScrollCollection,
  LiveWhere,
} from "@plugins/network/plugins/live/core";

// A DataView's LIVE data origin: a `network/live` collection declared
// `scroll: true`, read as key-range pages (`useLive`), the pages near the
// rows on screen live. The view's sort, filter, search and group-by lower onto
// its window params, and the rows stay live through the routed runtime. The
// types live here (the props union names them); the constructor,
// `liveDataSource`, is web's (`web/internal/live-data-source.ts`).

/** The `text`-domain filterable columns of a collection — what a search box may match. */
export type LiveSearchableColumn<F> = {
  [K in keyof F & string]: F[K] extends FilterColumn<"text", unknown>
    ? K
    : never;
}[keyof F & string];

/**
 * The columns a live source may declare as FACETS: its `text`-domain
 * filterable columns (enums included — an enum is a text column narrowed in
 * tsc). A facet's options are the values the column takes, read live as a
 * grouping — a number / instant / array column has no option list to read.
 */
export type LiveFacetColumn<F> = LiveSearchableColumn<F>;

/**
 * A live source's scope — the base filter ANDed into every tuple before the
 * view's own: `all` (the whole collection), `where` (the canonical filter
 * `scoped` built), or `awaiting` — the scope's value is not known yet (mail's
 * account still loading), only the columns it will constrain. An awaiting
 * source reads nothing and renders the DataView's loading state, its toolbar
 * already mounted, so a surface whose scope arrives late shows one loading
 * state, not a bare skeleton followed by the list's own.
 */
export type LiveSourceScope =
  | { readonly kind: "all" }
  | { readonly kind: "where"; readonly filter: Filter }
  | { readonly kind: "awaiting"; readonly columns: readonly string[] };

/**
 * A live DataView source (`<DataView source={…} />`): the collection, the
 * columns its search box matches, and its scope. Its row type is the
 * collection's, so a `DataView<T>` over another row type is a tsc error.
 */
export interface LiveDataSource<TRow> {
  readonly kind: "live";
  readonly collection: LiveScrollCollection<TRow, unknown, string>;
  /** Text-domain filterable columns the search box matches (`contains`, any of). */
  readonly searchable: readonly string[];
  /**
   * Text-domain filterable columns whose values are read live (a grouping of
   * the column over the source's scope) and handed to the field over that
   * column as its `optionsResult` — the Filter control's option list, never
   * declared by hand.
   */
  readonly facets: readonly string[];
  readonly scope: LiveSourceScope;
}

/** A live source typed to its collection's filterable columns — what `scoped` narrows by. */
export interface LiveDataSourceOf<TRow, F> extends LiveDataSource<TRow> {
  /**
   * The same source over the rows matching `where` too — scope stated as data
   * (mail's account). Its columns must be filterable (they are routed like any
   * other); no field lowers to a scope-only column, so the view's own filter
   * control can neither name nor widen it.
   */
  scoped(opts: { where: LiveWhere<F> }): LiveDataSourceOf<TRow, F>;
  /**
   * The same source while its scope is not known yet: `columns` are the ones
   * the coming `scoped({ where })` will constrain (kept out of the Filter
   * control already, so it does not change under the user). Reads nothing —
   * the DataView shows its loading state with its toolbar mounted.
   */
  awaitingScope(columns: readonly (keyof F & string)[]): LiveDataSource<TRow>;
}
