import {
  and,
  filterColumns,
  type Filter,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveCollection,
  LiveWhere,
} from "@plugins/network/plugins/live/core";
import type {
  LiveCustomColumns,
  LiveDataSourceOf,
  LiveFacetColumn,
  LiveSearchableColumn,
  LiveSourceScope,
  LiveSurfaceBinding,
} from "../../core";

// The constructor of a DataView's live data origin (its types are core's,
// `core/internal/live-data-source.ts`).

/**
 * Declare a live DataView source over a collection's window (a lookup-only or
 * `all` collection has none: a tsc error). `searchable` names the text columns
 * the search box matches; `facets` the text columns whose values the Filter
 * control offers as options, read live (`LiveDataSource.facets`).
 *
 * `surface` is the DataView it is listed on, and how the surface's custom
 * columns reach the collection is stated, never a fallback
 * (`LiveSurfaceBinding`): a collection whose `columnScope` is the surface
 * takes them as scoped columns (another surface is a tsc error); one without
 * a scope says why (`unscoped: { reason }`).
 */
export function liveDataSource<
  Row,
  F,
  S extends string,
  // The collection as declared — its literal `columnScope` read off it whole
  // (inferring the scope alone would merge it with `LiveCollection`'s own
  // `string | null` and lose the literal).
  C extends { readonly columnScope: string | null },
>(
  collection: LiveCollection<Row, F, S> & C,
  opts: {
    searchable: readonly LiveSearchableColumn<F>[];
    facets?: readonly LiveFacetColumn<F>[];
  } & LiveSurfaceBinding<C["columnScope"]>,
): LiveDataSourceOf<Row, F> {
  const surface = opts.surface;
  const scope: string | null = collection.columnScope;
  // tsc already binds the two; this catches a widened or cast declaration at
  // module load, where it is declared.
  const customColumns: LiveCustomColumns =
    scope !== null
      ? { kind: "scoped", scope }
      : { kind: "unscoped", reason: opts.unscoped?.reason ?? "" };
  if (customColumns.kind === "scoped" && scope !== surface) {
    throw new Error(
      `liveDataSource("${collection.key}"): its column scope is "${scope}", but it is listed on "${surface}" — a collection with a column scope is listed on that one surface.`,
    );
  }
  if (customColumns.kind === "scoped" && opts.unscoped !== undefined) {
    throw new Error(
      `liveDataSource("${collection.key}"): a collection with a column scope takes its surface's custom columns — \`unscoped\` says the opposite.`,
    );
  }
  if (
    customColumns.kind === "unscoped" &&
    customColumns.reason.trim().length === 0
  ) {
    throw new Error(
      `liveDataSource("${collection.key}"): the collection takes no column scope, so "${surface}"'s custom columns cannot sort or filter it — say why (\`unscoped: { reason }\`), or give the collection \`columnScope: "${surface}"\`.`,
    );
  }
  const filterable = collection.filterable as Record<
    string,
    { domain: string } | undefined
  >;
  const facets = opts.facets ?? [];
  // tsc already narrows both lists to text columns; this catches an erased
  // (cast) declaration at module load, where it is declared.
  for (const [role, columns] of [
    ["searchable", opts.searchable],
    ["facet", facets],
  ] as const) {
    for (const column of columns) {
      if (filterable[column]?.domain !== "text") {
        throw new Error(
          `liveDataSource("${collection.key}"): ${role} column "${column}" must be a declared text column.`,
        );
      }
    }
  }
  if (new Set(facets).size !== facets.length) {
    throw new Error(
      `liveDataSource("${collection.key}"): a facet column is listed twice (${facets.join(", ")}).`,
    );
  }
  const codec = collection.window.window;
  const erased = collection as unknown as LiveCollection<Row, unknown, string>;
  const make = (scope: Filter | undefined): LiveDataSourceOf<Row, F> => ({
    kind: "live",
    collection: erased,
    searchable: opts.searchable,
    facets,
    surface,
    customColumns,
    scope:
      scope === undefined ? { kind: "all" } : { kind: "where", filter: scope },
    scoped: ({ where }) => {
      // The codec validates the columns and canonicalizes; its strict decode
      // hands the canonical tree back.
      const added = codec.decode(codec.encode({ where })).where;
      const parts = [scope, added].filter((f): f is Filter => f !== undefined);
      return make(
        parts.length === 0
          ? undefined
          : codec.decode(codec.encode({ where: and(...parts) as LiveWhere<F> }))
              .where,
      );
    },
    awaitingScope: (columns) => {
      for (const column of columns) {
        if (filterable[column] === undefined) {
          throw new Error(
            `liveDataSource("${collection.key}").awaitingScope: "${column}" is not a filterable column — a scope constrains filterable columns only.`,
          );
        }
      }
      const awaiting: LiveSourceScope = {
        kind: "awaiting",
        columns: [
          ...columns,
          ...(scope === undefined ? [] : filterColumns(scope)),
        ],
      };
      return {
        kind: "live",
        collection: erased,
        searchable: opts.searchable,
        facets,
        surface,
        customColumns,
        scope: awaiting,
      };
    },
  });
  return make(undefined);
}
