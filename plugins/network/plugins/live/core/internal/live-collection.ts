import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  registerResourceDescriptor,
  type ResourceDescriptor,
  type ResourcePreload,
} from "@plugins/primitives/plugins/live-state/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import type { FieldsRecord } from "@plugins/fields/core";
import type {
  AllQueryResourceContract,
  PointQueryResourceContract,
  WindowQueryResourceContract,
} from "@plugins/infra/plugins/query-resource/core";
import {
  LIST_MAX,
  type Filterable,
  type FilterScalar,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  LIVE_GROUP_DEFAULT_LIMIT,
  type LiveCountParams,
  type LiveDecodedCountQuery,
  type LiveDecodedGroupQuery,
  type LiveDecodedQuery,
  type LiveGroup,
  type LiveGroupParams,
  type LiveGroupQuery,
  type LiveOrderBy,
  type LiveQuery,
  type LiveSortDirection,
  type LiveWindowBounds,
  type LiveWindowParams,
} from "./query";
import { LIVE_ROW_KEY } from "./row-key";
import type { MachineFeature } from "@plugins/infra/plugins/endpoints/core";
import {
  machineFields,
  type LiveMachineBrand,
  type LiveMachineSpec,
} from "./needs-machine";
import { createLiveQueryCodec } from "./query-codec";
import { mintColumnRef, type LiveColumnRef } from "./column-ref";
import {
  LIVE_COLUMNS_KEY,
  LIVE_SCOPED_KEY,
  type LiveColumnsDeclaration,
  type WithContributedColumns,
} from "./live-columns";
import {
  isFieldsSpec,
  isShape,
  resolveFieldsSpec,
  type FieldsRow,
  type FieldsSpecExposes,
  type FieldsSpecFilterable,
  type FromEntity,
  type FromFields,
  type LabelledKeys,
  type LiveFields,
  type LiveFieldsSpec,
  type LiveFrom,
  type LiveRelated,
  type RequireLabel,
} from "./live-fields";
import {
  allResourceDescriptor,
  pointQueryResourceDescriptor,
  windowQueryResourceDescriptor,
} from "./window-descriptor";

/** The window descriptor's codec: the query ⇄ wire-params pair, plus the bounds it enforces. */
export interface LiveWindowCodec<F, S extends string> {
  /** The window every consumer gets when it names none. */
  defaultLimit: number;
  /** No encoded or decoded window exceeds this (encode/decode throw, never clamp). */
  maxLimit: number;
  defaultOrderBy: LiveOrderBy<S>;
  /**
   * Canonical encode. Throws on an undeclared column, an op its domain does
   * not take, a bad operand, a limit above `maxLimit`, or a cut (`bounds`)
   * that is not a row key of the query's order.
   */
  encode: (
    query?: LiveQuery<F, S>,
    bounds?: LiveWindowBounds,
  ) => LiveWindowParams;
  /**
   * STRICT decode with every default filled in. Throws unless `params` is
   * exactly a canonical encoding. A server folding column sets passes the
   * ones it serves: a query may name their columns, and nothing else.
   */
  decode: (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ) => LiveDecodedQuery<S>;
  /**
   * The query a tuple is one page of: one string for every page of one query
   * (its filter and order), whatever its cuts and limit — what the server
   * derives a page from (see the resource runtime's seeded derivation).
   */
  familyOf: (params: LiveWindowParams) => string;
}

/**
 * The window half of a collection: a `WindowQueryResourceContract` over the
 * query codec's params and selector, whose `window` codec is the richer query
 * codec (decode yields `{ limit, where, orderBy }`, not just `limit`) — so the
 * existing `windowQueryResource` compiler accepts it unchanged.
 */
export type LiveWindowDescriptor<Row, F, S extends string> = Omit<
  WindowQueryResourceContract<Row, LiveWindowParams, LiveQuery<F, S>>,
  // Replaced, not intersected: an intersected `decode` would be an overload
  // whose limit-only arm wins every call.
  "window"
> & {
  window: LiveWindowCodec<F, S>;
};

/** The groups descriptor's codec: the grouping query ⇄ wire-params pair, plus its bounds. */
export interface LiveGroupCodec<F> {
  /** Groups a grouping query returns when it names no `limit`. */
  defaultLimit: number;
  /** No grouping query returns more groups than this (the filter language's `LIST_MAX`). */
  maxLimit: number;
  /** Canonical encode. Throws on a non-groupable `groupBy`, a bad `where`, a limit above max, or an `orderBy`. */
  encode: (query: LiveGroupQuery<F>) => LiveGroupParams;
  /**
   * STRICT decode. Throws unless `params` is exactly a canonical encoding. The
   * server passes the column sets a grouping may name (its exposed ones).
   */
  decode: (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ) => LiveDecodedGroupQuery<keyof F & string>;
}

/**
 * `${key}:groups` — a plain (non-keyed) push value per grouping query. Every
 * groupable column's values share the wire schema (any scalar or NULL); the
 * server validates each value against the row schema's field. A grouping not
 * loaded yet is `pending`, never `[]`.
 */
export type LiveGroupsDescriptor<F> = ResourceDescriptor<
  LiveGroup<FilterScalar>[],
  LiveGroupParams
> & { keyed?: never; groups: LiveGroupCodec<F> };

/** The count descriptor's codec: the count query ⇄ wire-params pair. */
export interface LiveCountCodec {
  /** Canonical encode. Throws on a bad `where`. */
  encode: (query: {
    where?: object;
    columns?: readonly LiveColumnsDeclaration[];
  }) => LiveCountParams;
  /**
   * STRICT decode. Throws unless `params` is exactly a canonical encoding. The
   * server passes the column sets a count's `where` may name.
   */
  decode: (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ) => LiveDecodedCountQuery;
}

/**
 * `${key}:count` — a plain (non-keyed) push value per `where`: how many rows of
 * the collection match it. Minted only for a collection declared `count: true`.
 * Preloaded with the collection: its param-less `{}` tuple (the whole
 * collection's total) hydrates beside the default window.
 */
export type LiveCountDescriptor<F> = ResourceDescriptor<
  number,
  LiveCountParams
> & {
  keyed?: never;
  initialData?: never;
  count: LiveCountCodec;
  /** Phantom — the filterable columns a count's `where` may name. */
  readonly __filterable?: F;
};

/**
 * A collection's row schema: a zod OBJECT, so its keys can be read — the server
 * projects exactly these keys, which is what keeps a server-only column (a
 * dedup key, a secret) off the wire.
 */
export type LiveRowSchema<Row> = ZodParser<Row> & {
  readonly shape: { readonly [K in keyof NoInfer<Row>]-?: unknown };
};

/**
 * When a declaration is loaded ahead of any mount — one type for `liveValue`
 * and `liveCollection`:
 *
 * - `"none"` (the default): on first mount.
 * - `"boot"`: hydrated by the boot snapshot before first paint (at the
 *   declaration's default tuple), which pins the owning plugin to the eager
 *   tier; a DB-backed one is also L2-persisted for instant cold boot.
 * - `"boot-and-keep"`: `"boot"`, and the client keeps the cached value resident
 *   for the tab's lifetime, so a surface that mounts late never re-enters a
 *   loading window boot already closed.
 *
 * A collection preloads its default WINDOW only — the server cannot know a
 * tab's id sets or grouping queries at boot.
 */
export type LivePreload = "none" | ResourcePreload;

/**
 * What EVERY collection has — the `:rows` point sibling and the row schema — so
 * the id-set reads (`useLive(c, { ids })`, `useLiveRow`) take any collection,
 * lookup-only or full.
 */
export interface LiveRowsCollection<Row> {
  key: string;
  /** `${key}:rows` — explicit id sets; answers "does this row exist", ignoring any filter. */
  rows: PointQueryResourceContract<Row>;
  id: keyof Row & string;
  /** The row schema — its keys are exactly the fields the server projects. */
  row: LiveRowSchema<Row>;
  /** The row schema's keys — exactly the fields the server projects. */
  rowKeys: readonly (keyof Row & string)[];
  /**
   * Declared `exposes`: the entities whose extensions' exposed fields its rows
   * carry under `$columns` — relation (`base`, or a declared lookup join's
   * alias) → entity. `null` = none.
   */
  exposes: LiveExposes | null;
  /**
   * The fields every list of it shows (`pick` and own `fields`), by id, in
   * declaration order — their labels, types, options and filter domains (see
   * {@link LiveFields}).
   */
  fields: LiveFields;
  /**
   * The entity its rows are (`from: entityRef`) — whose presentation
   * (`FieldPresentation.Register({ owner: entity })`) its lists apply to the
   * picked fields. `null` over an extension shape or no `from`.
   */
  from: EntityRef | null;
  /**
   * What its rows ARE, as declared: its `from` — an entity ref or an
   * extension shape — or `null` for a collection declared by its own fields
   * alone (served from outside Postgres, or a union of arms). `serveCollection`
   * asserts the table it reads is this one: a collection over an entity's
   * table is `from` it, never a restatement of its fields.
   */
  rowsFrom: LiveFrom | null;
}

/**
 * What a collection's rows reach: `base` (the collection's own entity) or the
 * alias of a lookup join its server half declares → the entity it reads. Every
 * extension exposing fields of one of those entities folds into the rows
 * (`$columns[<slice>]`) — the collection names none of them.
 */
export type LiveExposes = Readonly<Record<string, EntityRef>>;

/** A full collection: the point sibling plus a default window and groupings to list it by. */
export interface LiveCollection<
  Row,
  F,
  S extends string,
> extends LiveRowsCollection<Row> {
  /** `key` — the ordered, filtered, bounded window. */
  window: LiveWindowDescriptor<Row, F, S>;
  /** `${key}:groups` — the values a filterable column takes, with counts. */
  groups: LiveGroupsDescriptor<F>;
  /**
   * `${key}:count` — how many rows match a `where`; `null` unless the
   * collection is declared `count: true` (see {@link LiveCollectionSpec.count}).
   */
  count: LiveCountDescriptor<F> | null;
  /** The filterable columns' domains — the filter language's declaration. */
  filterable: F;
  sortable: readonly S[];
  /**
   * Declared `columnScope`: the scope its scoped column sets (a DataView
   * surface's custom columns — `LiveColumns.Scoped` on the server,
   * `scopedLiveColumns` in the browser) resolve their members in; `null` = none.
   */
  columnScope: string | null;
  /**
   * Declared `arms`: a UNION collection — rows of several kinds (arms), each
   * served from its own table; `discriminator` is the row field naming a
   * row's arm, and each arm's own fields ride under `$columns[<arm>]`
   * (`liveArm`). `null` = a single-table collection.
   */
  arms: LiveArms | null;
  /**
   * A declared filterable or sortable column, as a list binds a field to it
   * (`FieldDef.column`) — for a field whose id is not its column name.
   */
  // `NoInfer`: a method parameter would otherwise widen `S` to every
  // filterable name wherever a collection is passed to a generic function.
  column(name: NoInfer<(keyof F & string) | S>): LiveColumnRef;
  /** A whole ordered set is the `all` overload's ({@link LiveAllCollection}). */
  all?: never;
}

/**
 * What `liveCollection` mints for a window declaration: a collection whose row
 * carries `$columns` when it reaches exposures. Never a union (`arms: null`):
 * a single-table collection is what
 * `serveCollection` serves.
 */
export type LiveCollectionOf<
  Row,
  F,
  S extends string,
  Cn = undefined,
  Ex = undefined,
> = ([Ex] extends [undefined]
  ? LiveCollection<Row, F, S>
  : LiveCollection<WithContributedColumns<Row>, F, S>) &
  (Cn extends true ? { count: LiveCountDescriptor<F> } : { count: null }) & {
    arms: null;
  };

/**
 * A collection declared `count: true` — the only kind `useLive(c, { count })`
 * reads.
 */
export type LiveCountedCollection<Row, F, S extends string> = LiveCollection<
  Row,
  F,
  S
> & { count: LiveCountDescriptor<F> };

/** A union collection's arms declaration: the row field naming each row's arm. */
export interface LiveArms<D extends string = string> {
  readonly discriminator: D;
}

/**
 * A UNION collection (`liveCollection(key, { arms })`): a window whose rows
 * carry `$columns` — each arm's own fields, under its kind (`liveArm`) — and
 * whose `discriminator` field names a row's arm.
 */
export type LiveArmsCollection<
  Row,
  F,
  S extends string,
  D extends keyof Row & string = keyof Row & string,
> = LiveCollection<WithContributedColumns<Row>, F, S> & {
  columnScope: null;
  arms: LiveArms<D>;
  count: null;
};

/**
 * What a declaration with no window mints (see {@link LiveNoWindowSpec}): the
 * `:rows` point sibling, and — declared `all` (`Al` set) — the whole ordered
 * set under `key`. A list read of either has no window to read, so it is a
 * tsc error (the `window` / `groups` it needs are absent, typed `never`).
 *
 * `all` is a property whose type follows `Al` (`undefined` for a lookup-only
 * collection), never a conditional over the whole type: the resource
 * vocabulary infers `liveCollection`'s return type, and a top-level conditional
 * would hide the collection from it.
 */
export interface LiveNoWindowCollection<
  Row,
  Al,
> extends LiveRowsCollection<Row> {
  /**
   * `key` — every row, in `all.all.orderBy` order (the id breaks ties), one
   * tuple per scope when declared `by` (see {@link LiveAllOrder.by});
   * `undefined` when lookup-only.
   */
  all: [Al] extends [undefined]
    ? undefined
    : AllQueryResourceContract<Row, LiveAllBy<Al>>;
  window?: never;
  groups?: never;
}

/**
 * A lookup-only collection: declared without a default window, so it mints
 * `${key}:rows` alone. Rows are read by id (`useLiveRow`, `useLive(c, { ids })`).
 */
export type LiveLookupCollection<Row> = LiveNoWindowCollection<Row, undefined>;

/**
 * A collection declared `all` (`liveCollection(key, { all })`): `key` holds
 * EVERY row, in the declared order, as one param-less keyed resource — for a
 * set small enough to hold whole (`all.unbounded.reason` says why) whose
 * readers need all of it (a tree, a graph). Mints `key` and `${key}:rows` —
 * no `:groups` (a grouping is a window over the set; this set has none) and
 * no window. Serving it as a lookup-only collection is a tsc error (`all` is
 * `undefined` there).
 *
 * Declared `all: { by }` (`B` its fields), `key` holds every row OF ONE
 * SCOPE per tuple — `{ [K in B]: string }`, read `useLive(c, { where })` —
 * and is a different type: a scoped set is never the param-less one.
 */
export interface LiveAllCollection<
  Row,
  B extends string = never,
> extends LiveRowsCollection<Row> {
  all: AllQueryResourceContract<Row, B>;
  window?: never;
  groups?: never;
}

/** The `by` fields an `all` declaration (`Al`) scopes its tuples by — `never` when it declares none. */
export type LiveAllBy<Al> = Al extends {
  readonly by: readonly (infer B extends string)[];
}
  ? B
  : never;

export interface LiveCollectionSpec<Row, F, S extends string> {
  row: LiveRowSchema<Row>;
  /** The row field that identifies a row (the point sibling's id set, the window's tiebreaker). */
  id: keyof Row & string;
  /** Row field → domain constructor (`liveText(Schema)`, `liveBoolean()` …). */
  filterable: F;
  sortable: readonly S[];
  default: { orderBy: LiveOrderBy<S>; limit: number };
  /**
   * Hard cap on any window's limit. There is no unbounded spelling. At least
   * `2 · default.limit` (a declaration throw): every window is read as
   * key-range pages, and a page that splits is read at `2 · default.limit`,
   * so it holds its rows with a step of headroom before it is full again.
   */
  maxLimit: number;
  /** Default `"none"`. A preload reaches the DEFAULT WINDOW only (see {@link LivePreload}). */
  preload?: LivePreload;
  /**
   * The scope scoped column sets resolve their members in — the id of the
   * DataView surface this collection is listed on (its `storageKey`), whose
   * custom columns then sort and filter the window. A tuple naming one joins
   * only the members it names; its server half compiles at boot, once the
   * `LiveColumns.Scoped` contributions are collected. One scope per
   * collection: a surface listing it under another id cannot bind them.
   */
  columnScope?: string;
  /**
   * Mint `${key}:count` — how many rows match a `where`, kept live (a COUNT
   * recomputed on every write to a table the collection reads). The author's
   * statement that this COUNT is cheap: a DataView listing the collection then
   * shows exact section counts, not lower bounds, while only its scope
   * applies. Leave it off a large or write-hot table.
   */
  count?: true;
  /**
   * The entities its rows reach (see {@link LiveExposes}): every extension
   * exposing fields of one of them folds into the rows under `$columns` (the
   * row type becomes `Row & { $columns }`), and a query sorts, filters and
   * groups by them under their wire names (`<slice>.<field>`). Its server half
   * compiles at boot, once the `LiveColumns.Expose` contributions are
   * collected.
   */
  exposes?: LiveExposes;
  /** A union collection is the `arms` overload's ({@link LiveArmsSpec}). */
  arms?: never;
  /** A whole ordered set is the `all` overload's ({@link LiveAllSpec}). */
  all?: never;
}

/**
 * A UNION collection's declaration (T12): a window over N arms — tables of
 * several kinds listed in one order, each arm's own fields declared by
 * `liveArm` and riding its rows under `$columns[<arm>]`. Its column
 * vocabulary is closed — every arm is a static declaration — so it takes no
 * exposures and no `columnScope`.
 */
export interface LiveArmsSpec<
  Row,
  F,
  S extends string,
  D extends string,
> extends Omit<
  LiveCollectionSpec<Row, F, S>,
  "columnScope" | "arms" | "count" | "exposes"
> {
  /** The row field naming each row's arm (its value is the arm's kind). */
  arms: LiveArms<D>;
  columnScope?: never;
  exposes?: never;
  /** Not yet: a union's total would sum its arms' counts. */
  count?: never;
}

/**
 * The `all` of a whole-ordered-set declaration: the total order every row is
 * held in, and why the set may be held whole.
 */
export interface LiveAllOrder<Row> {
  /**
   * Scope the set: one tuple per value of these row fields (non-empty, each
   * once, never the id), holding the rows whose fields equal the tuple's
   * params — `by: ["pageId"]` is one page's rows, read
   * `useLive(c, { where: { pageId } })`. Each must bind to a base column of
   * text, uuid or integer type (the server's compile refuses any other: the
   * change feed carries it as text, which must equal the param). A scoped
   * set is never preloaded (a scope is named by a reader), so never
   * L2-persisted.
   */
  by?: readonly (keyof NoInfer<Row> & string)[];
  /** Row fields with their direction; non-empty, each field once. The id breaks ties. */
  orderBy: LiveOrderBy<keyof NoInfer<Row> & string>;
  /** Why the whole set is held: it has no other bound. Non-empty. */
  unbounded: { reason: string };
}

/**
 * A declaration with no window: a row schema and its id, nothing to list by,
 * plus — for the whole set — `all` (`Al`). Every window and union field is
 * `never` (`filterable` too: no list read or grouping would ever read it).
 *
 * - **Lookup-only** (`Al` = `undefined`, no `all`): `preload` is `never` too —
 *   an id set has no default tuple the server could load before a tab names
 *   one. Mints `${key}:rows` alone.
 * - **The whole ordered set** (`all` set, T13): `preload` reaches `key` (boot
 *   hydrates it, and a DB-backed one is L2-persisted). Mints `key` and
 *   `${key}:rows`.
 *
 * One overload for both, so `liveCollection` keeps three: past three failed
 * candidates TypeScript reports only the last one's errors, which would move
 * every misdeclared spec's error off the field at fault.
 */
export interface LiveNoWindowSpec<
  Row,
  Al extends LiveAllOrder<Row> | undefined,
> {
  row: LiveRowSchema<Row>;
  /** The row field that identifies a row — the point sibling's id set (and the whole set's tiebreaker). */
  id: keyof Row & string;
  all?: Al;
  /** Only the whole set preloads — never a scoped one (`by`). Default `"none"`. */
  preload?: [Al] extends [undefined]
    ? never
    : [LiveAllBy<Al>] extends [never]
      ? LivePreload
      : never;
  /**
   * Only the whole set reaches exposures (see {@link LiveExposes}): its rows
   * carry them under `$columns`, compiled at boot like a window's.
   */
  exposes?: [Al] extends [undefined] ? never : LiveExposes;
  filterable?: never;
  sortable?: never;
  default?: never;
  maxLimit?: never;
  columnScope?: never;
  arms?: never;
  count?: never;
}

/** A lookup-only declaration (see {@link LiveNoWindowSpec}). */
export type LiveLookupSpec<Row> = LiveNoWindowSpec<Row, undefined>;

/** A whole-ordered-set declaration (see {@link LiveNoWindowSpec}). */
export type LiveAllSpec<Row> = LiveNoWindowSpec<Row, LiveAllOrder<Row>> & {
  all: LiveAllOrder<Row>;
};

/** A window's default, in the fields spelling (its order over `S`). */
export interface LiveFieldsDefault<S extends string> {
  readonly orderBy: LiveOrderBy<S>;
  readonly limit: number;
}

/**
 * The FORM half of a declaration in the fields spelling — picked by what the
 * spec sets, like the old spelling's three overloads:
 *
 * - `default` (`W`): a WINDOW — `sortable` (index-backed, so explicit; any row
 *   field), `maxLimit`, `preload`, `columnScope`, `count`;
 * - `all` (`Al`): the WHOLE ORDERED SET — `preload` (unless scoped `by`),
 *   and no window field;
 * - neither: LOOKUP-ONLY — no window field, no preload, and it reaches no
 *   entity (`related` is `never`; `from` names its fields only).
 */
export type LiveFieldsForm<W, Al, S extends string, Cn, R> = [W] extends [
  undefined,
]
  ? {
      sortable?: never;
      maxLimit?: never;
      columnScope?: never;
      count?: never;
      preload?: [Al] extends [undefined]
        ? never
        : [LiveAllBy<Al>] extends [never]
          ? LivePreload
          : never;
      related?: [Al] extends [undefined] ? never : R;
    }
  : {
      sortable: readonly S[];
      maxLimit: number;
      preload?: LivePreload;
      columnScope?: string;
      count?: Cn;
      all?: never;
    };

/**
 * Declare a live collection: one declaration minting three resources — `key`
 * (window membership: filtered, ordered, limited), `${key}:rows` (point
 * membership: explicit ids) and `${key}:groups` (a filterable column's values
 * with counts) — and, declared `count: true`, `${key}:count` (how many rows
 * match a `where`). Bounded by construction: a default limit and a `maxLimit` are
 * required, and a grouping query is capped at `LIST_MAX` groups.
 *
 * Declared WITHOUT `default` (and so without `sortable` / `maxLimit` /
 * `filterable` / `preload`), it is lookup-only and mints `${key}:rows` alone —
 * for a table whose rows are only ever read by id (one row per mounted block).
 *
 * Declared with `arms`, it is a UNION collection over several tables: see
 * {@link LiveArmsSpec}.
 *
 * Declared with `all` (and no window field), it holds every row, in one
 * declared order: it mints `key` (the whole ordered set, param-less) and
 * `${key}:rows` — see {@link LiveAllSpec}.
 *
 * `key` stays a positional string literal: the build scanners read it statically.
 */
export function liveCollection<
  const E extends LiveFrom | undefined = undefined,
  const P extends LabelledKeys<FromFields<E>> = never,
  const CP extends keyof FromFields<E> & string = never,
  const OF extends FieldsRecord = Record<never, never>,
  const CF extends FieldsRecord = Record<never, never>,
  const R extends LiveRelated | undefined = undefined,
  const B extends false | undefined = undefined,
  const Al extends LiveAllOrder<FieldsRow<E, P, CP, OF, CF>> | undefined =
    undefined,
  NM extends MachineFeature | undefined = undefined,
>(
  key: string,
  spec: Omit<LiveFieldsSpec<E, P, CP, OF, CF, R>, "related" | "fields"> & {
    /** The row field that identifies a row — a picked, carried or own field. */
    id: NoInfer<keyof FieldsRow<E, P, CP, OF, CF> & string>;
    fields?: OF & RequireLabel<OF>;
    related?: R;
    baseExposures?: B;
    arms?: never;
    default?: never;
    all?: Al;
  } & LiveFieldsForm<undefined, Al, never, undefined, R> &
    LiveMachineSpec<NM>,
): LiveNoWindowCollection<
  [Al] extends [undefined]
    ? FieldsRow<E, P, CP, OF, CF>
    : [FieldsSpecExposes<E, R, B>] extends [undefined]
      ? FieldsRow<E, P, CP, OF, CF>
      : WithContributedColumns<FieldsRow<E, P, CP, OF, CF>>,
  Al
> & {
  fields: LiveFields<P | (keyof OF & string)>;
  from: FromEntity<E>;
} & LiveMachineBrand<NM>;
export function liveCollection<
  const OF extends FieldsRecord,
  const CF extends FieldsRecord = Record<never, never>,
  const S extends keyof FieldsRow<undefined, never, never, OF, CF> & string =
    never,
  // The source field is a LISTED base field: every list of the union shows,
  // filters and groups by it (its options are the arms, derived by the list).
  const D extends keyof OF & string = never,
  const I extends keyof FieldsRow<undefined, never, never, OF, CF> & string =
    never,
>(
  key: string,
  spec: Omit<
    LiveArmsSpec<FieldsRow<undefined, never, never, OF, CF>, never, S, D>,
    "row" | "filterable" | "id" | "default"
  > & {
    /** The base fields every arm projects — each labelled (`RequireLabel`). */
    fields: OF & RequireLabel<OF>;
    /** Base fields on the row no list shows (the union key, an arm-local id). */
    carry?: { fields?: CF };
    /** The union row key (minted by the compiler, never bound by an arm). */
    id: I;
    default: LiveFieldsDefault<S>;
    row?: never;
    filterable?: never;
    from?: never;
    pick?: never;
    related?: never;
    baseExposures?: never;
  },
): LiveArmsCollection<
  FieldsRow<undefined, never, never, OF, CF>,
  FieldsSpecFilterable<undefined, never, OF>,
  S,
  D
> & { fields: LiveFields<keyof OF & string>; from: null; id: I };
export function liveCollection<
  const E extends LiveFrom | undefined = undefined,
  const P extends LabelledKeys<FromFields<E>> = never,
  const CP extends keyof FromFields<E> & string = never,
  const OF extends FieldsRecord = Record<never, never>,
  const CF extends FieldsRecord = Record<never, never>,
  const R extends LiveRelated | undefined = undefined,
  const B extends false | undefined = undefined,
  const S extends keyof FieldsRow<E, P, CP, OF, CF> & string = never,
  const Cn extends true | undefined = undefined,
  NM extends MachineFeature | undefined = undefined,
>(
  key: string,
  spec: Omit<LiveFieldsSpec<E, P, CP, OF, CF, R>, "related" | "fields"> & {
    /** The row field that identifies a row — a picked, carried or own field. */
    id: NoInfer<keyof FieldsRow<E, P, CP, OF, CF> & string>;
    fields?: OF & RequireLabel<OF>;
    related?: R;
    baseExposures?: B;
    arms?: never;
    default: LiveFieldsDefault<S>;
  } & LiveFieldsForm<LiveFieldsDefault<S>, undefined, S, Cn, R> &
    LiveMachineSpec<NM>,
): LiveCollectionOf<
  FieldsRow<E, P, CP, OF, CF>,
  FieldsSpecFilterable<E, P, OF>,
  S,
  Cn,
  FieldsSpecExposes<E, R, B>
> & {
  fields: LiveFields<P | (keyof OF & string)>;
  from: FromEntity<E>;
} & LiveMachineBrand<NM>;
export function liveCollection<Row, F, S extends string>(
  key: string,
  declared: LiveFieldsSpec<
    LiveFrom | undefined,
    string,
    string,
    FieldsRecord,
    FieldsRecord,
    LiveRelated | undefined
  >,
): unknown {
  // A collection declares its FIELDS (`./live-fields`); its row schema, filter
  // domains and the entities it reaches are derived from them, then minted.
  // The old `row` / `filterable` / `exposes` spelling is gone (fields declared
  // once, phase 2b): an untyped caller still spelling it is told so.
  if (!isFieldsSpec(declared)) {
    throw new Error(
      `liveCollection("${key}"): declare the collection's fields — \`from\` (an entity or an extension shape) with \`pick\`, own \`fields\`, \`carry\` — the \`row\` / \`filterable\` / \`exposes\` spelling no longer exists.`,
    );
  }
  {
    const fieldsSpec = declared as unknown as Parameters<
      typeof resolveFieldsSpec
    >[1] & {
      default?: unknown;
      all?: unknown;
      arms?: unknown;
      sortable?: readonly string[];
      needsMachine?: MachineFeature;
    };
    // A union's rows are no entity's: its base fields are its own, and each
    // arm's are the arm's (`liveArm`).
    if (fieldsSpec.arms !== undefined) {
      const stray: string[] = (
        ["from", "pick", "related", "baseExposures"] as const
      ).filter((k) => fieldsSpec[k] !== undefined);
      if (fieldsSpec.carry?.pick !== undefined) stray.push("carry.pick");
      if (stray.length > 0) {
        throw new Error(
          `liveCollection("${key}"): ${stray.join(", ")} beside \`arms\` — a union collection's rows are no entity's: it declares its base fields itself (\`fields\` / \`carry.fields\`), each arm its own (\`liveArm\`).`,
        );
      }
    }
    if (fieldsSpec.arms !== undefined) {
      // The source field (a Meta-DataView's): a listed base field, so every
      // list of the union shows, filters and groups by it — its options are
      // the union's arms (`liveArm({ label, order })`), derived by the list,
      // never declared beside them.
      const discriminator = (fieldsSpec.arms as LiveArms).discriminator;
      const field = (fieldsSpec.fields ?? {})[discriminator];
      if (field === undefined) {
        throw new Error(
          `liveCollection("${key}"): the discriminator "${discriminator}" is not a field listed in \`fields\` — declare it there, with a label: it is the union's source field.`,
        );
      }
      if (field.meta.optionMeta !== undefined) {
        throw new Error(
          `liveCollection("${key}"): the discriminator "${discriminator}" declares options — a union's source options are its arms (\`liveArm({ label, order })\`), derived by every list.`,
        );
      }
    }
    const resolved = resolveFieldsSpec(key, fieldsSpec);
    const {
      from: _from,
      pick: _pick,
      related: _related,
      fields: _fields,
      carry: _carry,
      baseExposures: _baseExposures,
      needsMachine: _needsMachine,
      ...rest
    } = fieldsSpec;
    if (fieldsSpec.arms !== undefined && _needsMachine !== undefined) {
      // Unreachable from typed code (the union overload takes none): a
      // union's arms are served by other plugins, each its own host.
      throw new Error(
        `liveCollection("${key}"): \`needsMachine\` beside \`arms\` — a union collection's arms are served by their own plugins; declare it on a single-table collection.`,
      );
    }
    const window = fieldsSpec.default !== undefined;
    const lookup = !window && fieldsSpec.all === undefined;
    const minted = mintCollection(key, {
      ...rest,
      row: resolved.row,
      ...(window ? { filterable: resolved.filterable } : {}),
      // A lookup-only collection folds no exposure (its `:rows` is compiled
      // eagerly, never deferred): its rows are its own fields.
      ...(lookup || resolved.exposes === null
        ? {}
        : { exposes: resolved.exposes }),
    } as unknown as LiveCollectionSpec<Row, F, S>);
    const sortable = [
      ...(fieldsSpec.sortable ?? []),
      ...(
        (fieldsSpec.all as { orderBy?: [string, string][] } | undefined)
          ?.orderBy ?? []
      ).map(([f]) => f),
    ];
    const from = fieldsSpec.from;
    return {
      ...minted,
      fields: resolved.fields(sortable),
      from: from !== undefined && !isShape(from) ? from : null,
      rowsFrom: from ?? null,
      ...machineFields(fieldsSpec),
    };
  }
}

/**
 * Mint a declaration from what its fields derive (`row`, `filterable`,
 * `exposes` — internal: no caller spells them) — every form.
 */
function mintCollection<Row, F, S extends string>(
  key: string,
  spec:
    | LiveCollectionSpec<Row, F, S>
    | LiveLookupSpec<Row>
    | LiveArmsSpec<Row, F, S, string>
    | LiveAllSpec<Row>,
):
  | LiveCollection<Row, F, S>
  | LiveLookupCollection<Row>
  | LiveAllCollection<Row> {
  // First: every other branch reads `default`, which an `all` spec lacks, so
  // an `all` spec reaching them would be minted as lookup-only (C16).
  // `contributed` is gone (fields-declared-once): an untyped caller still
  // passing it would otherwise mint a collection silently missing its columns.
  if ((spec as { contributed?: unknown }).contributed !== undefined) {
    throw new Error(
      `liveCollection("${key}"): \`contributed\` no longer exists — another plugin's columns are an extension's exposed fields (\`defineExtensionShape({ exposes })\`), folded into every collection reaching its entity.`,
    );
  }
  if (spec.all !== undefined)
    return allCollection(key, spec as LiveAllSpec<Row>);
  if (spec.arms !== undefined) {
    // An untyped caller could pass what the overload forbids (T12): a union's
    // column vocabulary is its arms' static handles.
    const fail = (message: string): never => {
      throw new Error(`liveCollection("${key}"): ${message}`);
    };
    const stray = (["columnScope", "count", "exposes"] as const).filter(
      (f) => (spec as unknown as Record<string, unknown>)[f] !== undefined,
    );
    if (stray.length > 0) {
      fail(
        `${stray.join(", ")} beside \`arms\` — a union collection's columns are its arms' own (\`liveArm\`), never scoped or exposed, and it has no total yet.`,
      );
    }
    if (spec.default === undefined) {
      fail("`arms` without `default` — a union collection is a window.");
    }
    const discriminator = spec.arms.discriminator;
    if (!Object.hasOwn(spec.row.shape, discriminator)) {
      fail(
        `the discriminator "${discriminator}" is not a field of the row schema`,
      );
    }
    if (discriminator === spec.id) {
      fail(
        `the discriminator "${discriminator}" is the id — a row's key names its arm, its arm is a field of its own`,
      );
    }
    return fullCollection(key, spec as LiveArmsSpec<Row, F, S, string>);
  }
  if (spec.default === undefined) {
    // An untyped caller could pass half a window: every window field goes
    // with `default`, so a stray one is a declaration that means nothing.
    const stray = Object.entries(spec)
      .filter(([f, v]) => v !== undefined && WINDOW_FIELDS.includes(f))
      .map(([f]) => f);
    if (stray.length > 0) {
      throw new Error(
        `liveCollection("${key}"): ${stray.join(", ")} without \`default\` — a ` +
          `lookup-only collection has no window to list, sort, cap or preload.`,
      );
    }
    return { ...rowsPart(key, spec, null), all: undefined };
  }
  return fullCollection(key, spec as LiveCollectionSpec<Row, F, S>);
}

/** The spec fields an `all` declaration never takes: every window and union field. */
const NOT_ALL_FIELDS: readonly string[] = [
  "default",
  "arms",
  "filterable",
  "sortable",
  "maxLimit",
  "columnScope",
  "count",
];

const SORT_DIRECTIONS: readonly LiveSortDirection[] = ["asc", "desc"];

/**
 * The `all` overload: `key` (every row, in `all.orderBy` order — one tuple
 * per scope when declared `by`) and `:rows`. Throws on what the overload
 * forbids for an untyped caller — a window or union field beside `all`, a
 * preload beside `by` — and on what no type states: an empty reason, an
 * empty `orderBy` or `by`, an order or scope field that is not a row field
 * (or is named twice), a scope field that is the id, a direction that is
 * neither `asc` nor `desc`.
 */
function allCollection<Row>(
  key: string,
  spec: LiveAllSpec<Row>,
): LiveAllCollection<Row> {
  const fail = (message: string): never => {
    throw new Error(`liveCollection("${key}"): ${message}`);
  };
  const stray = NOT_ALL_FIELDS.filter(
    (f) => (spec as unknown as Record<string, unknown>)[f] !== undefined,
  );
  if (stray.length > 0) {
    fail(
      `${stray.join(", ")} beside \`all\` — the whole ordered set has no window, ` +
        "grouping, union arms, or scoped columns.",
    );
  }
  // Read as untyped: the checks below are for a caller the types did not reach.
  const all = spec.all as {
    by?: unknown;
    orderBy?: unknown;
    unbounded?: { reason?: unknown };
  };
  const reason = all.unbounded?.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(
      `liveCollection("${key}"): \`all.unbounded.reason\` is empty — the whole set has no other bound, so say why it stays small.`,
    );
  }
  if (!Array.isArray(all.orderBy) || all.orderBy.length === 0) {
    fail("`all.orderBy` is empty — the set is held in one declared order.");
  }
  const orderBy = spec.all.orderBy;
  const seen = new Set<string>();
  for (const [field, dir] of orderBy) {
    if (!Object.hasOwn(spec.row.shape, field)) {
      fail(
        `\`all.orderBy\` names "${field}", which is not a field of the row schema`,
      );
    }
    if (!SORT_DIRECTIONS.includes(dir)) {
      fail(
        `\`all.orderBy\` sorts "${field}" ${JSON.stringify(dir)} — neither "asc" nor "desc"`,
      );
    }
    if (seen.has(field)) fail(`\`all.orderBy\` names "${field}" twice`);
    seen.add(field);
  }
  const by = allBy(fail, spec, all.by);
  // A set reaching exposures carries them under `$columns`, declared on the
  // row schema like a window's (`rowKeys` stay the author's fields).
  const exposes = checkExposes(key, spec.exposes);
  const row = exposes === null ? spec.row : withColumnsSchema(key, spec.row);
  // Minted before `:rows`, as a window is (descriptor registration order).
  // `"none"` is the absence of the descriptor field.
  // Erased over the scope: `B` is the declaration's (the overload's return
  // type), the descriptor's gate reads `by` at runtime.
  const descriptor = allResourceDescriptor<Row, string>(key, row, spec.id, {
    all: {
      orderBy: Object.freeze(
        orderBy.map(([f, d]) => Object.freeze([f, d] as const)),
      ),
      unbounded: Object.freeze({ reason }),
      ...(by === null ? {} : { by }),
    } as AllQueryResourceContract<Row, string>["all"],
    ...(spec.preload === undefined || spec.preload === "none"
      ? {}
      : { preload: spec.preload }),
  });
  return {
    ...rowsPart(key, { row, id: spec.id }, exposes),
    rowKeys: Object.keys(spec.row.shape) as (keyof Row & string)[],
    all: descriptor as unknown as AllQueryResourceContract<Row>,
  };
}

/**
 * An `all` declaration's `by` (see {@link LiveAllOrder.by}), checked: `null`
 * when it declares none, else its fields, frozen. A scope is named by a
 * reader, so a scoped set has no tuple boot could hydrate — a preload beside
 * it throws (it is `never` in the types).
 */
function allBy<Row>(
  fail: (message: string) => never,
  spec: LiveAllSpec<Row>,
  by: unknown,
): readonly (keyof Row & string)[] | null {
  if (by === undefined) return null;
  if (!Array.isArray(by) || by.length === 0) {
    fail(
      "`all.by` is empty — leave it out for the whole set, or name the row fields a tuple is scoped by.",
    );
  }
  const fields = by as unknown[];
  const seen = new Set<string>();
  for (const field of fields) {
    if (typeof field !== "string" || !Object.hasOwn(spec.row.shape, field)) {
      fail(
        `\`all.by\` names ${JSON.stringify(field)}, which is not a field of the row schema`,
      );
    }
    const name = field as string;
    if (name === spec.id) {
      fail(
        `\`all.by\` names the id "${name}" — a scope of one row is a point read (\`useLiveRow\`).`,
      );
    }
    if (seen.has(name)) fail(`\`all.by\` names "${name}" twice`);
    seen.add(name);
  }
  if (spec.preload !== undefined && spec.preload !== "none") {
    fail(
      `\`preload: "${spec.preload}"\` beside \`all.by\` — a scoped set's tuples are named by its readers, so boot has none to hydrate (and it is never L2-persisted).`,
    );
  }
  return Object.freeze([...(fields as (keyof Row & string)[])]);
}

/** A relation of `exposes` is `base` or a join alias: a plain identifier. */
const RELATION_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Check a declared `exposes` (see {@link LiveExposes}) — what no type states:
 * an empty one, a relation that is no identifier, a value that is not an
 * `EntityRef`, one entity reached through two relations (its exposures would
 * fold twice under one slice).
 */
function checkExposes(
  key: string,
  exposes: LiveExposes | undefined,
): LiveExposes | null {
  if (exposes === undefined) return null;
  const fail = (message: string): never => {
    throw new Error(`liveCollection("${key}"): \`exposes\` ${message}`);
  };
  const entries = Object.entries(exposes);
  if (entries.length === 0) fail("is empty — leave it out.");
  const seen = new Map<string, string>();
  for (const [relation, ref] of entries) {
    if (!RELATION_RE.test(relation)) {
      fail(`names relation "${relation}", which is not an identifier.`);
    }
    if (ref?.kind !== "entity") {
      fail(`maps "${relation}" to a value that is not an EntityRef.`);
    }
    const other = seen.get(ref.name);
    if (other !== undefined) {
      fail(
        `reaches entity "${ref.name}" through both "${other}" and "${relation}" — one entity, one relation (its exposures fold once).`,
      );
    }
    seen.set(ref.name, relation);
  }
  return Object.freeze({ ...exposes });
}

/** The spec fields that only mean something beside `default` (or `all`). */
const WINDOW_FIELDS: readonly string[] = [
  "exposes",
  "filterable",
  "sortable",
  "maxLimit",
  "preload",
  "columnScope",
  "arms",
  "count",
];

/** The `:rows` point sibling and the row schema — what every collection mints. */
function rowsPart<Row>(
  key: string,
  spec: { row: LiveRowSchema<Row>; id: keyof Row & string },
  exposes: LiveExposes | null,
): LiveRowsCollection<Row> {
  return {
    key,
    rows: pointQueryResourceDescriptor(`${key}:rows`, spec.row, spec.id),
    id: spec.id,
    row: spec.row,
    rowKeys: Object.keys(spec.row.shape) as (keyof Row & string)[],
    exposes,
    // Set by `liveCollection` from the declaration's fields.
    fields: Object.freeze({}),
    from: null,
    rowsFrom: null,
  };
}

function fullCollection<Row, F, S extends string>(
  key: string,
  spec: LiveCollectionSpec<Row, F, S> | LiveArmsSpec<Row, F, S, string>,
): LiveCollection<Row, F, S> {
  if (spec.maxLimit < 2 * spec.default.limit) {
    throw new Error(
      `liveCollection("${key}"): maxLimit must be ≥ 2 · default.limit ` +
        `(${2 * spec.default.limit}), got ${spec.maxLimit} — a window is read as key-range ` +
        `pages, and a page that splits is read at 2 · default.limit, a step of headroom ` +
        `over the rows it holds.`,
    );
  }
  const arms: LiveArms | null = spec.arms ?? null;
  const exposes = checkExposes(
    key,
    (spec as { exposes?: LiveExposes }).exposes,
  );
  // A union's rows carry its arms' own fields under `$columns` beside the
  // author's fields: declared on the row schema (so every parse keeps it),
  // never bound to a column (the server folds the arms' projections into it).
  // A collection reaching exposures carries its exposed slices the same way.
  const row =
    arms !== null || exposes !== null
      ? withColumnsSchema(key, spec.row)
      : spec.row;
  const columnScope = spec.columnScope ?? null;
  if (columnScope !== null && columnScope.length === 0) {
    throw new Error(`liveCollection("${key}"): \`columnScope\` is empty`);
  }
  const codec = createLiveQueryCodec<keyof F & string, S>({
    key,
    id: spec.id,
    columnScope,
    arms: arms !== null,
    exposes: exposes === null ? [] : Object.values(exposes).map((r) => r.name),
    // `LiveFilterable`'s keys are optional; a declared one always holds a column.
    filterable: spec.filterable as unknown as Filterable,
    sortable: spec.sortable,
    defaultOrderBy: spec.default.orderBy,
    defaultLimit: spec.default.limit,
    maxLimit: spec.maxLimit,
  });
  const windowCodec: LiveWindowCodec<F, S> = {
    defaultLimit: spec.default.limit,
    maxLimit: spec.maxLimit,
    defaultOrderBy: spec.default.orderBy,
    encode: codec.encode,
    decode: codec.decode,
    familyOf: codec.familyOf,
  };
  // Built on the window factory (descriptor registration, keyed `keyOf`,
  // `queryPk`), then its limit-only codec is replaced by the query codec. The
  // default window encodes to the same `{ limit }` bytes either way.
  // Only the window (and a declared `:count`, at its unfiltered `{}` tuple) is
  // ever preloaded: `:rows` and `:groups` have no default tuple the server
  // could load before a tab names one. The flag is forwarded
  // as is — `"none"` is the absence of the descriptor field.
  const preloadOpts: { preload?: ResourcePreload } =
    spec.preload === undefined || spec.preload === "none"
      ? {}
      : { preload: spec.preload };
  // Every window row carries the server-minted `$key` beside the row fields
  // (its position in the order, where a page may be cut): declared on the
  // wire schema (so the runtime's parse keeps it), and split off by every
  // read before rows reach a consumer.
  // A scoped collection's window rows carry `$scoped` beside them when the
  // tuple orders by a scoped column (the member values its order signature
  // reads) — declared the same way, split off the same way.
  const windowKeys: Record<string, z.ZodTypeAny> = {
    [LIVE_ROW_KEY]: z.string().nullable(),
    ...(columnScope !== null
      ? { [LIVE_SCOPED_KEY]: z.record(z.string(), z.unknown()).optional() }
      : {}),
  };
  const windowRow = z.intersection(
    row as unknown as z.ZodTypeAny,
    z.object(windowKeys),
  ) as unknown as ZodParser<Row>;
  const window = Object.assign(
    windowQueryResourceDescriptor(key, windowRow, spec.id, {
      defaultLimit: spec.default.limit,
      ...preloadOpts,
    }),
    {
      window: windowCodec,
      defaultParams: windowCodec.encode(),
      // The gate is the query codec's strict decode, like the window codec.
      validateParams: (params: Record<string, string>) =>
        void windowCodec.decode(params),
    },
  );
  // Minted after the window, as it always was (descriptor registration order).
  // `rowKeys` stay the author's fields: `$columns` is folded, never bound.
  const base = {
    ...rowsPart(key, { row, id: spec.id }, exposes),
    rowKeys: Object.keys(spec.row.shape) as (keyof Row & string)[],
  };
  const groupCodec: LiveGroupCodec<F> = {
    defaultLimit: LIVE_GROUP_DEFAULT_LIMIT,
    maxLimit: LIST_MAX,
    encode: codec.encodeGroups,
    decode: codec.decodeGroups,
  };
  // Minted and registered here, like the window and `:rows`: no placeholder.
  const groups: LiveGroupsDescriptor<F> = {
    key: `${key}:groups`,
    schema: z.array(
      z.object({
        value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
        count: z.number().int().nonnegative(),
      }),
    ),
    groups: groupCodec,
    validateParams: (params: Record<string, string>) =>
      void groupCodec.decode(params),
  };
  registerResourceDescriptor(groups as ResourceDescriptor<unknown>);
  // Minted after `:groups` (descriptor registration order), only when declared.
  // Preloaded with the window: its `{}` tuple is the whole collection's total.
  let count: LiveCountDescriptor<F> | null = null;
  if ((spec as { count?: true }).count === true) {
    const countCodec: LiveCountCodec = {
      encode: codec.encodeCount,
      decode: codec.decodeCount,
    };
    count = {
      key: `${key}:count`,
      schema: z.number().int().nonnegative(),
      count: countCodec,
      validateParams: (params: Record<string, string>) =>
        void countCodec.decode(params),
      ...preloadOpts,
    };
    registerResourceDescriptor(count as ResourceDescriptor<unknown>);
  }
  const filterable = spec.filterable as unknown as Filterable;
  const column = (name: string): LiveColumnRef => {
    const declared = Object.hasOwn(filterable, name)
      ? filterable[name]!
      : undefined;
    const sortable = (spec.sortable as readonly string[]).includes(name);
    if (declared === undefined && !sortable) {
      throw new Error(
        `liveCollection("${key}").column("${name}"): not a declared filterable or sortable column`,
      );
    }
    return mintColumnRef({
      owner: { kind: "own", collection: key },
      name,
      domain: declared?.domain ?? null,
      sortable,
    });
  };
  return {
    ...base,
    window,
    groups,
    count,
    filterable: spec.filterable,
    sortable: spec.sortable,
    columnScope,
    arms,
    column,
  };
}

/** The row schema with `$columns` declared beside the author's fields (a zod object's `extend`, so its keys stay readable). */
function withColumnsSchema<Row>(
  key: string,
  row: LiveRowSchema<Row>,
): LiveRowSchema<Row> {
  const extend = (row as unknown as { extend?: unknown }).extend;
  if (typeof extend !== "function") {
    throw new Error(
      `liveCollection("${key}"): a union or exposing collection's row must be a zod object`,
    );
  }
  if (Object.hasOwn(row.shape, LIVE_COLUMNS_KEY)) {
    throw new Error(
      `liveCollection("${key}"): "${LIVE_COLUMNS_KEY}" is reserved — the arm or exposed values ride under it`,
    );
  }
  return (row as unknown as z.AnyZodObject).extend({
    [LIVE_COLUMNS_KEY]: z.record(z.string(), z.record(z.string(), z.unknown())),
  }) as unknown as LiveRowSchema<Row>;
}
