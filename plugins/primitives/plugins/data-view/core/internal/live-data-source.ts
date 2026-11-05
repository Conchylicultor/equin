import type {
  Filter,
  FilterColumn,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveCollection,
  LiveTree,
  LiveWhere,
} from "@plugins/network/plugins/live/core";
import type { DataViewId } from "./define-data-view";

// A DataView's LIVE data origin: a `network/live` collection's window, read
// as key-range pages (`useLive`), the pages near the rows on screen live. The view's sort, filter, search and group-by lower onto
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
 * A tree collection's structure as a live source carries it
 * (`LiveCollection.tree`, network/live): the filterable column holding a
 * row's parent id (`null` = a root), and the sortable column ordering
 * siblings.
 */
export type LiveTreeSpec = LiveTree;

/** The tree a collection type declares (`LiveTreeSpec`), or `null`. */
export type LiveTreeOf<C> = C extends { readonly tree: infer T }
  ? [T] extends [LiveTreeSpec]
    ? T
    : null
  : null;

/**
 * A live DataView source (`<DataView source={…} />`): the collection, the
 * columns its search box matches, and its scope. Its row type is the
 * collection's, so a `DataView<T>` over another row type is a tsc error.
 *
 * `T` is its collection's tree (`LiveTreeSpec`, `null` for no tree): a source
 * over a tree collection nests its rows, and only it takes a `hierarchy`
 * (`DataViewLiveOrigin`).
 */
export interface LiveDataSource<
  TRow,
  T extends LiveTreeSpec | null = LiveTreeSpec | null,
> {
  readonly kind: "live";
  readonly collection: LiveCollection<TRow, unknown, string>;
  /** The collection's tree (`collection.tree`), `null` for a flat collection. */
  readonly tree: T;
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
  /** The DataView surface this source is listed on (`defineDataView`) — the `storageKey` it mounts under. */
  readonly surface: DataViewId;
  /** How the surface's custom columns reach the collection (see {@link LiveCustomColumns}). */
  readonly customColumns: LiveCustomColumns;
}

/**
 * How a live surface's custom columns (user-defined fields) reach its
 * collection — stated by every live source, never a silent fallback:
 *
 * - `scoped` — the collection takes `scopedColumns`: each custom column of
 *   `scope` (the surface listing it) joins the window as a scoped column,
 *   sorting and filtering in SQL — a query naming one carries the surface;
 * - `unscoped` — the collection cannot take a surface's scoped columns, for
 *   the written `reason` (served outside Postgres): custom columns show and
 *   edit, and do not sort or filter.
 */
export type LiveCustomColumns =
  | { readonly kind: "scoped"; readonly scope: string }
  | { readonly kind: "unscoped"; readonly reason: string };

/** How a surface's custom columns reach its rows: in memory, or as its live source states. */
export type SurfaceCustomColumns =
  LiveCustomColumns | { readonly kind: "in-memory" };

/**
 * What a live source states about its surface, from its collection's literal
 * `scopedColumns` (`Sc`): a collection taking them takes the custom columns
 * of whichever surface lists it; one without names its surface and says why
 * its custom columns cannot sort or filter it (`unscoped` — a tsc error to
 * leave out, and to state beside a collection that takes them).
 */
export type LiveSurfaceBinding<Sc extends boolean> = [Sc] extends [true]
  ? { surface: DataViewId; unscoped?: never }
  : { surface: DataViewId; unscoped: { reason: string } };

/** A live source over a tree collection — the one a DataView nests, and the one taking a `hierarchy`. */
export type LiveTreeDataSource<TRow> = LiveDataSource<TRow, LiveTreeSpec>;

/** A live source typed to its collection's filterable columns — what `scoped` narrows by. */
export interface LiveDataSourceOf<
  TRow,
  F,
  T extends LiveTreeSpec | null = LiveTreeSpec | null,
> extends LiveDataSource<TRow, T> {
  /**
   * The same source over the rows matching `where` too — scope stated as data
   * (mail's account). Its columns must be filterable (they are routed like any
   * other); no field lowers to a scope-only column, so the view's own filter
   * control can neither name nor widen it.
   */
  scoped(opts: { where: LiveWhere<F> }): LiveDataSourceOf<TRow, F, T>;
  /**
   * The same source while its scope is not known yet: `columns` are the ones
   * the coming `scoped({ where })` will constrain (kept out of the Filter
   * control already, so it does not change under the user). Reads nothing —
   * the DataView shows its loading state with its toolbar mounted.
   */
  awaitingScope(
    columns: readonly (keyof F & string)[],
  ): LiveDataSource<TRow, T>;
}
