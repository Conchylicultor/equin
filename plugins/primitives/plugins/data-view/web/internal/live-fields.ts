import type {
  Filter,
  Filterable,
  FilterColumn,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  filterColumns,
  isFilterGroup,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  LiveColumnsDeclaration,
  LiveGroupableDomain,
} from "@plugins/network/plugins/live/core";
import type {
  FieldDef,
  FieldGrouping,
  FilterOperatorSet,
  LiveDataSource,
} from "../../core";

// A live DataView source's field resolution — pure, so the checks run wherever
// a field is declared (the host's body, or a field-extension contributor's
// own render) and are testable without React.

export type ResolveOperatorSet = (
  typeId: string,
) => FilterOperatorSet | undefined;

/** How one field reads the collection: the column it lowers to, and what that column takes. */
interface FieldColumn {
  /** The column's wire name (a column set's is `<set>.<field>`). */
  name: string;
  /** The column set that declared it (an exposure, an arm, a scoped set); absent for the collection's own. */
  handle?: LiveColumnsDeclaration;
  /** The filter domain the column takes; `null` = not filterable. */
  domain: string | null;
  sortable: boolean;
}

/** What a live source offers a view's controls, and how each offered field lowers. */
export interface LiveFieldPlan<TRow> {
  /** Fields the Filter control offers — each one's column is filterable in its operator set's domain. */
  filterFields: FieldDef<TRow>[];
  /** The filter declaration keyed by FIELD id (what the view's filter lowers against). */
  filterable: Filterable;
  /** Fields the Sort control offers — each one's column is sortable. */
  sortFields: FieldDef<TRow>[];
  /** Field id → the column it lowers to (filter and sort). */
  columnOf: ReadonlyMap<string, string>;
  /**
   * The column sets the offered fields bind to, by set name — a query naming
   * one of their columns hands the codec that set.
   */
  handles: ReadonlyMap<string, LiveColumnsDeclaration>;
  /**
   * Field id → the column a `GROUP BY` can count it by: the collection's OWN
   * filterable column, or an EXPOSED one, of a text / number / boolean domain
   * (what the live codec's `checkGroupBy` accepts). An arm's or a scoped
   * column is never one — the server groups by its own and its exposed
   * columns only.
   */
  groupColumns: ReadonlyMap<string, LiveGroupColumn>;
}

/** A column a live grouping counts by. */
export interface LiveGroupColumn {
  name: string;
  domain: LiveGroupableDomain;
  /** The column set it belongs to (an exposure's, a union arm's) — the grouping hands it to the codec; absent for an own column. */
  handle?: LiveColumnsDeclaration;
}

const GROUPABLE_DOMAINS: ReadonlySet<string> = new Set<LiveGroupableDomain>([
  "text",
  "number",
  "boolean",
]);

/**
 * How a `(field, grouping)` pair lowers under a live source — the ONE answer
 * both the Group-by control (what it offers) and the source (what it reads)
 * take, so the control cannot offer a grouping the source would render wrong.
 *
 * - `sections` — a one-bucket-per-value grouping over a groupable column: the
 *   server lists every section with its exact count, each section pages its
 *   own rows (`DataViewSectioning` `declared`);
 * - `prefix` — a one-bucket-per-value grouping over a sortable column no
 *   grouping can count (an arm's): the column leads the order, so the
 *   sections are contiguous and follow appearance;
 * - `buckets` — any other grouping over a sortable column (a date by day): its
 *   buckets over the loaded rows, as in memory;
 * - `none` — over no sortable or groupable column (a derived value): the
 *   sections would say only what happens to be loaded, so it is not offered.
 */
export type LiveGroupLowering =
  | { kind: "sections"; column: LiveGroupColumn }
  | { kind: "prefix"; column: string }
  | { kind: "buckets" }
  | { kind: "none" };

export function liveGroupLowering<TRow>(
  plan: LiveFieldPlan<TRow>,
  field: FieldDef<TRow>,
  grouping: FieldGrouping,
): LiveGroupLowering {
  const sortable = plan.sortFields.some((f) => f.id === field.id);
  if (grouping.oneBucketPerValue === true) {
    const groupColumn = plan.groupColumns.get(field.id);
    if (groupColumn !== undefined) {
      return { kind: "sections", column: groupColumn };
    }
    return sortable
      ? { kind: "prefix", column: plan.columnOf.get(field.id)! }
      : { kind: "none" };
  }
  return sortable ? { kind: "buckets" } : { kind: "none" };
}

/** The collection column a field reads: its declared ref, else a column of the same name, else none. */
function columnFor<TRow>(
  field: FieldDef<TRow>,
  source: LiveDataSource<TRow>,
): FieldColumn | null {
  const c = source.collection;
  if (field.column !== undefined) {
    const owner = field.column.owner;
    switch (owner.kind) {
      case "scoped":
        if (owner.scope !== c.columnScope) {
          throw new Error(
            `data-view: field "${field.id}" names a scoped column of "${owner.scope}", but this DataView reads "${c.key}", whose column scope is ${c.columnScope === null ? "none" : `"${c.columnScope}"`}.`,
          );
        }
        break;
      case "own":
      case "arm":
        if (owner.collection !== c.key) {
          throw new Error(
            `data-view: field "${field.id}" names a column of "${owner.collection}", but this DataView reads "${c.key}" — a field's column must be its source collection's.`,
          );
        }
        break;
      case "exposed":
        // An exposure is read by every collection whose `exposes` reaches
        // its entity — never named by one — and by a union whose entity arm
        // reaches it (the server decodes against the arms it folds).
        if (
          c.arms == null &&
          !Object.values(c.exposes ?? {}).some((r) => r.name === owner.entity)
        ) {
          throw new Error(
            `data-view: field "${field.id}" names exposed columns of entity "${owner.entity}", but this DataView reads "${c.key}", whose \`exposes\` does not reach it.`,
          );
        }
        break;
      default:
        owner satisfies never;
    }
    return {
      name: field.column.name,
      domain: field.column.domain,
      sortable: field.column.sortable,
      ...(field.column.handle ? { handle: field.column.handle } : {}),
    };
  }
  const filterable = c.filterable as Record<string, FilterColumn | undefined>;
  const declared = Object.hasOwn(filterable, field.id)
    ? filterable[field.id]
    : undefined;
  const sortable = (c.sortable as readonly string[]).includes(field.id);
  if (declared === undefined && !sortable) return null;
  return { name: field.id, domain: declared?.domain ?? null, sortable };
}

/**
 * Resolve a schema against a live source — and check it where it is declared.
 * A field bound to a column (a `column` ref, or an id that IS a declared
 * column) must resolve: marked `sortable: true` over a column that does not
 * sort throws, and so does a filterable one whose operator set lowers over
 * another domain than its column's. A field bound to no column is display-only
 * (a derived value): never offered, never checked.
 *
 * A field over a column the source's SCOPE constrains (`source.scoped({ where
 * })` — mail's account) is never offered to the Filter control: the scope is
 * the surface's, stated as data, and a user rule over the same column could
 * only restate it or contradict it into an empty list. It still sorts.
 *
 * `who` names the declarer in the error — the host, or a field-extension
 * contributor, which calls this inside its own `render(fields)` so its error
 * boundary contains the crash.
 */
export function resolveLiveFields<TRow>(
  fields: readonly FieldDef<TRow>[],
  source: LiveDataSource<TRow>,
  resolveOperatorSet: ResolveOperatorSet,
  who: string,
): LiveFieldPlan<TRow> {
  const filterFields: FieldDef<TRow>[] = [];
  const sortFields: FieldDef<TRow>[] = [];
  const filterable: Record<string, FilterColumn> = {};
  const columnOf = new Map<string, string>();
  const handles = new Map<string, LiveColumnsDeclaration>();
  const groupColumns = new Map<string, LiveGroupColumn>();
  const ownFilterable = source.collection.filterable as Record<
    string,
    FilterColumn | undefined
  >;
  const scopeColumns: ReadonlySet<string> =
    source.scope.kind === "where"
      ? filterColumns(source.scope.filter)
      : new Set(source.scope.kind === "awaiting" ? source.scope.columns : []);
  for (const field of fields) {
    const column = columnFor(field, source);
    if (column === null) continue;
    columnOf.set(field.id, column.name);
    if (column.handle) handles.set(column.handle.name, column.handle);
    // What the server can `GROUP BY`: an own filterable column, or one of an
    // exposed set or a union arm's (its domain is the set's).
    const exposed =
      column.handle?.owner.kind === "exposed" ||
      column.handle?.owner.kind === "arm"
        ? column.handle
        : undefined;
    const groupDomain =
      exposed !== undefined
        ? column.domain
        : column.handle === undefined &&
            Object.hasOwn(ownFilterable, column.name)
          ? (ownFilterable[column.name]?.domain ?? null)
          : null;
    if (
      field.value !== undefined &&
      groupDomain !== null &&
      GROUPABLE_DOMAINS.has(groupDomain)
    ) {
      groupColumns.set(field.id, {
        name: column.name,
        domain: groupDomain as LiveGroupableDomain,
        ...(exposed !== undefined ? { handle: exposed } : {}),
      });
    }
    if (field.value !== undefined && field.sortable !== false) {
      if (column.sortable) sortFields.push(field);
      else if (field.sortable === true) {
        throw new Error(
          `data-view (${who}): field "${field.id}" is marked sortable, but its column "${column.name}" of "${source.collection.key}" is not declared sortable.`,
        );
      }
    }
    const set = resolveOperatorSet(field.type ?? "text");
    if (column.domain !== null && set !== undefined) {
      // An enum over booleans / numbers lowers in its values' domain.
      const domain = field.valueDomain ?? set.domain;
      if (domain !== column.domain) {
        throw new Error(
          `data-view (${who}): field "${field.id}" filters over ${domain} (its type "${field.type ?? "text"}"), but its column "${column.name}" of "${source.collection.key}" is declared ${column.domain}.`,
        );
      }
      if (scopeColumns.has(column.name)) continue;
      filterFields.push(field);
      filterable[field.id] = { domain: column.domain } as FilterColumn;
    }
  }
  return {
    filterFields,
    filterable,
    sortFields,
    columnOf,
    handles,
    groupColumns,
  };
}

/**
 * Check a declarer's fields against the data origin: under a live source every
 * field bound to a column must resolve (`resolveLiveFields` throws otherwise);
 * on any other origin a `column` ref would mean nothing, so it throws.
 */
export function checkFieldColumns(
  fields: FieldDef<unknown>[],
  source: LiveDataSource<unknown> | undefined,
  resolveOperatorSet: ResolveOperatorSet,
  who: string,
): void {
  if (source !== undefined) {
    resolveLiveFields(fields, source, resolveOperatorSet, who);
    return;
  }
  const bound = fields.find((f) => f.column !== undefined);
  if (bound !== undefined) {
    throw new Error(
      `data-view (${who}): field "${bound.id}" names a live column, but this DataView has no live \`source\` — the binding would be silently ignored.`,
    );
  }
}

/** Rename every clause's column through `rename` (field id → column name). */
export function renameColumns(
  filter: Filter,
  rename: (column: string) => string,
): Filter {
  if (isFilterGroup(filter)) {
    return "and" in filter
      ? { and: filter.and.map((f) => renameColumns(f, rename)) }
      : { or: filter.or.map((f) => renameColumns(f, rename)) };
  }
  return { ...filter, column: rename(filter.column) } as Filter;
}

/**
 * The column sets a query naming `columns` (wire names) hands the codec, and
 * which of those columns are CONTRIBUTED — an arm's or a scoped set's, never
 * the collection's own or an exposed one. A `GROUP BY` and a COUNT read only
 * the own and exposed columns, so a filter naming a contributed one can be
 * neither grouped nor counted.
 */
export function namedColumnSets(
  handles: ReadonlyMap<string, LiveColumnsDeclaration>,
  columns: Iterable<string>,
): { sets: LiveColumnsDeclaration[]; contributed: string[] } {
  const named = [...columns];
  const setOf = (c: string) =>
    [...handles.values()].find((h) => c.startsWith(`${h.name}.`));
  return {
    sets: [...handles.values()].filter((h) =>
      named.some((c) => c.startsWith(`${h.name}.`)),
    ),
    contributed: named.filter((c) => {
      const set = setOf(c);
      return set !== undefined && set.owner.kind !== "exposed";
    }),
  };
}

/**
 * The column scope a surface's field extensions bind scoped columns under
 * (`FieldExtensionProps.liveColumnScope`): its live collection's
 * `columnScope`, which must BE the surface's `storageKey` — a scope's members
 * are that one surface's definitions, so listing the collection under another
 * id would sort by columns this surface never defined. `null` without a live
 * source, or for a collection that takes no scoped columns.
 */
export function liveColumnScopeOf<TRow>(
  source: LiveDataSource<TRow> | undefined,
  storageKey: string,
): string | null {
  const scope = source?.collection.columnScope ?? null;
  if (scope !== null && scope !== storageKey) {
    throw new Error(
      `data-view: "${storageKey}" lists "${source!.collection.key}", whose column scope is "${scope}" — a collection with a column scope is listed on that one surface.`,
    );
  }
  return scope;
}
