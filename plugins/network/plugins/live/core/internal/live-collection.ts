import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  registerResourceDescriptor,
  type ResourceDescriptor,
  type ResourcePreload,
} from "@plugins/primitives/plugins/live-state/core";
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
  type LiveFilterable,
  type LiveGroup,
  type LiveGroupParams,
  type LiveGroupQuery,
  type LiveOrderBy,
  type LiveReservedColumn,
  type LiveQuery,
  type LiveSortDirection,
  type LiveWindowBounds,
  type LiveWindowParams,
} from "./query";
import { LIVE_ROW_KEY } from "./row-key";
import { createLiveQueryCodec } from "./query-codec";
import { mintColumnRef, type LiveColumnRef } from "./column-ref";
import {
  LIVE_COLUMNS_KEY,
  LIVE_SCOPED_KEY,
  type LiveColumnsDeclaration,
  type LiveContributedCollection,
  type WithContributedColumns,
} from "./live-columns";
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
   * not take, a bad operand, a limit above `maxLimit`, or a cut (`bounds`) on a
   * collection not declared `scroll` / not a row key of the query's order.
   */
  encode: (
    query?: LiveQuery<F, S>,
    bounds?: LiveWindowBounds,
  ) => LiveWindowParams;
  /**
   * STRICT decode with every default filled in. Throws unless `params` is
   * exactly a canonical encoding. A contributed collection's server passes the
   * handles it serves: a query may name their columns, and nothing else.
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
  /** STRICT decode. Throws unless `params` is exactly a canonical encoding. */
  decode: (
    params: Record<string, string>,
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
  encode: (query: { where?: object }) => LiveCountParams;
  /** STRICT decode. Throws unless `params` is exactly a canonical encoding. */
  decode: (params: Record<string, string>) => LiveDecodedCountQuery;
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
}

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
   * Declared `scroll: true`: its window takes page cuts and projects each
   * row's `$key`, so it may be read as key-range pages (`useLive`, a live
   * DataView source).
   */
  scroll: boolean;
  /**
   * Declared `contributed: true`: other plugins may add columns to it
   * (`liveColumns`), carried on every row under `$columns`.
   */
  contributed: boolean;
  /**
   * Declared `columnScope`: the scope its scoped column sets (a DataView
   * surface's custom columns — `LiveColumns.Scoped` on the server,
   * `scopedLiveColumns` in the browser) resolve their members in; `null` = none.
   */
  columnScope: string | null;
  /**
   * Declared `arms`: a UNION collection — rows of several kinds (arms), each
   * served from its own table; `discriminator` is the row field naming a
   * row's arm, and each arm's own columns ride under `$columns[<arm>]`
   * (`liveArmColumns`). `null` = a single-table collection.
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
 * A collection declared `scroll: true` — the only kind read as key-range
 * pages (`useLive`, and so a live DataView source): its window projects
 * each row's `$key` and takes `after` / `until` cuts.
 */
export type LiveScrollCollection<Row, F, S extends string> = LiveCollection<
  Row,
  F,
  S
> & { scroll: true };

/**
 * What `liveCollection` mints for a window declaration: a collection whose row
 * carries `$columns` when declared `contributed`, and flagged `scroll` when
 * declared so. Never a union (`arms: null`): a single-table collection is what
 * `serveCollection` serves.
 */
export type LiveCollectionOf<
  Row,
  F,
  S extends string,
  Sc,
  Co,
  Cn = undefined,
> = (Co extends true
  ? LiveContributedCollection<Row, F, S>
  : LiveCollection<Row, F, S>) &
  (Sc extends true ? { scroll: true } : unknown) &
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
 * A UNION collection (`liveCollection(key, { arms })`): a scroll collection
 * whose rows carry `$columns` — each arm's own columns, under its kind
 * (`liveArmColumns`) — and whose `discriminator` field names a row's arm.
 */
export type LiveArmsCollection<
  Row,
  F,
  S extends string,
  D extends keyof Row & string = keyof Row & string,
> = LiveCollection<WithContributedColumns<Row>, F, S> & {
  scroll: true;
  contributed: false;
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
  /** `key` — every row, in `all.all.orderBy` order (the id breaks ties); `undefined` when lookup-only. */
  all: [Al] extends [undefined] ? undefined : AllQueryResourceContract<Row>;
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
 */
export type LiveAllCollection<Row> = LiveNoWindowCollection<
  Row,
  LiveAllOrder<Row>
>;

export interface LiveCollectionSpec<Row, F, S extends string> {
  row: LiveRowSchema<Row>;
  /** The row field that identifies a row (the point sibling's id set, the window's tiebreaker). */
  id: keyof Row & string;
  /** Row field → domain constructor (`liveText(Schema)`, `liveBoolean()` …). */
  filterable: F;
  sortable: readonly S[];
  default: { orderBy: LiveOrderBy<S>; limit: number };
  /** Hard cap on any window's limit. There is no unbounded spelling. */
  maxLimit: number;
  /** Default `"none"`. A preload reaches the DEFAULT WINDOW only (see {@link LivePreload}). */
  preload?: LivePreload;
  /**
   * May be read as key-range pages (`useLive`, a live DataView source):
   * the window projects each row's `$key` and takes `after` / `until` cuts.
   * Needs `maxLimit ≥ 2 · default.limit` (a declaration throw): a page that
   * splits is read at `2 · default.limit`, so it holds its rows with a step of
   * headroom before it is full again.
   */
  scroll?: true;
  /**
   * Other plugins may contribute columns to it (`liveColumns` handles, served
   * by `serveColumns` in a `LiveColumns.Serve` contribution): its rows carry
   * them under `$columns` (the row type becomes `Row & { $columns }`), and a
   * query sorts and filters by them under their wire names. Its server half
   * compiles at boot, once contributions are collected.
   */
  contributed?: true;
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
  /** A union collection is the `arms` overload's ({@link LiveArmsSpec}). */
  arms?: never;
  /** A whole ordered set is the `all` overload's ({@link LiveAllSpec}). */
  all?: never;
}

/**
 * A UNION collection's declaration (T12): a window over N arms — tables of
 * several kinds listed in one order, each arm's own columns declared by
 * `liveArmColumns` and riding its rows under `$columns[<arm>]`. Always a
 * scroll (`scroll: true`, required): a union is listed as a live DataView.
 * Its column vocabulary is closed — every arm's set is a static handle — so it
 * takes no `contributed` columns and no `columnScope`.
 */
export interface LiveArmsSpec<
  Row,
  F,
  S extends string,
  D extends string,
> extends Omit<
  LiveCollectionSpec<Row, F, S>,
  "scroll" | "contributed" | "columnScope" | "arms" | "count"
> {
  /** The row field naming each row's arm (its value is the arm's kind). */
  arms: LiveArms<D>;
  scroll: true;
  contributed?: never;
  columnScope?: never;
  /** Not yet: a union's total would sum its arms' counts. */
  count?: never;
}

/**
 * The `all` of a whole-ordered-set declaration: the total order every row is
 * held in, and why the set may be held whole.
 */
export interface LiveAllOrder<Row> {
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
  /** Only the whole set preloads. Default `"none"`. */
  preload?: [Al] extends [undefined] ? never : LivePreload;
  filterable?: never;
  sortable?: never;
  default?: never;
  maxLimit?: never;
  scroll?: never;
  contributed?: never;
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
 * Declared with `arms` (and so `scroll: true`), it is a UNION collection over
 * several tables: see {@link LiveArmsSpec}.
 *
 * Declared with `all` (and no window field), it holds every row, in one
 * declared order: it mints `key` (the whole ordered set, param-less) and
 * `${key}:rows` — see {@link LiveAllSpec}.
 *
 * `key` stays a positional string literal: the build scanners read it statically.
 */
export function liveCollection<
  Row,
  const F extends LiveFilterable<Row>,
  const S extends keyof Row & string = never,
  const D extends keyof Row & string = never,
>(
  key: string,
  spec: LiveArmsSpec<Row, F, S, D> & {
    filterable: {
      [
        K in Exclude<keyof F, keyof Row> | Extract<keyof F, LiveReservedColumn>
      ]: never;
    };
  },
): LiveArmsCollection<Row, F, S, D>;
export function liveCollection<
  Row,
  const F extends LiveFilterable<Row>,
  const S extends keyof Row & string = never,
  const Sc extends true | undefined = undefined,
  const Co extends true | undefined = undefined,
  const Cn extends true | undefined = undefined,
>(
  key: string,
  spec: LiveCollectionSpec<Row, F, S> & {
    scroll?: Sc;
    contributed?: Co;
    count?: Cn;
    filterable: {
      [
        K in Exclude<keyof F, keyof Row> | Extract<keyof F, LiveReservedColumn>
      ]: never;
    };
  },
): LiveCollectionOf<Row, F, S, Sc, Co, Cn>;
export function liveCollection<
  Row,
  const Al extends LiveAllOrder<Row> | undefined = undefined,
>(
  key: string,
  spec: LiveNoWindowSpec<Row, Al>,
): LiveNoWindowCollection<Row, Al>;
export function liveCollection<Row, F, S extends string>(
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
  if (spec.all !== undefined)
    return allCollection(key, spec as LiveAllSpec<Row>);
  if (spec.arms !== undefined) {
    // An untyped caller could pass what the overload forbids (T12): a union's
    // column vocabulary is its arms' static handles, and it is always a scroll.
    const fail = (message: string): never => {
      throw new Error(`liveCollection("${key}"): ${message}`);
    };
    const stray = (["contributed", "columnScope", "count"] as const).filter(
      (f) => (spec as unknown as Record<string, unknown>)[f] !== undefined,
    );
    if (stray.length > 0) {
      fail(
        `${stray.join(", ")} beside \`arms\` — a union collection's columns are its arms' own (\`liveArmColumns\`), never contributed or scoped, and it has no total yet.`,
      );
    }
    if (spec.default === undefined) {
      fail("`arms` without `default` — a union collection is a window.");
    }
    if ((spec as { scroll?: unknown }).scroll !== true) {
      fail(
        "`arms` needs `scroll: true` — a union collection is listed as a scroll.",
      );
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
    return { ...rowsPart(key, spec), all: undefined };
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
  "scroll",
  "contributed",
  "columnScope",
  "count",
];

const SORT_DIRECTIONS: readonly LiveSortDirection[] = ["asc", "desc"];

/**
 * The `all` overload: `key` (every row, in `all.orderBy` order) and `:rows`.
 * Throws on what the overload forbids for an untyped caller — a window or
 * union field beside `all` — and on what no type states: an empty reason, an
 * empty `orderBy`, an order field that is not a row field (or named twice),
 * a direction that is neither `asc` nor `desc`.
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
        "grouping, union arms, or contributed or scoped columns.",
    );
  }
  // Read as untyped: the checks below are for a caller the types did not reach.
  const all = spec.all as {
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
  // Minted before `:rows`, as a window is (descriptor registration order).
  // `"none"` is the absence of the descriptor field.
  const descriptor = allResourceDescriptor(key, spec.row, spec.id, {
    all: {
      orderBy: Object.freeze(
        orderBy.map(([f, d]) => Object.freeze([f, d] as const)),
      ),
      unbounded: Object.freeze({ reason }),
    },
    ...(spec.preload === undefined || spec.preload === "none"
      ? {}
      : { preload: spec.preload }),
  });
  return { ...rowsPart(key, spec), all: descriptor };
}

/** The spec fields that only mean something beside `default`. */
const WINDOW_FIELDS: readonly string[] = [
  "filterable",
  "sortable",
  "maxLimit",
  "preload",
  "scroll",
  "contributed",
  "columnScope",
  "arms",
  "count",
];

/** The `:rows` point sibling and the row schema — what every collection mints. */
function rowsPart<Row>(
  key: string,
  spec: { row: LiveRowSchema<Row>; id: keyof Row & string },
): LiveRowsCollection<Row> {
  return {
    key,
    rows: pointQueryResourceDescriptor(`${key}:rows`, spec.row, spec.id),
    id: spec.id,
    row: spec.row,
    rowKeys: Object.keys(spec.row.shape) as (keyof Row & string)[],
  };
}

function fullCollection<Row, F, S extends string>(
  key: string,
  spec: LiveCollectionSpec<Row, F, S> | LiveArmsSpec<Row, F, S, string>,
): LiveCollection<Row, F, S> {
  const scroll = spec.scroll === true;
  if (scroll && spec.maxLimit < 2 * spec.default.limit) {
    throw new Error(
      `liveCollection("${key}"): \`scroll: true\` needs maxLimit ≥ 2 · default.limit ` +
        `(${2 * spec.default.limit}), got ${spec.maxLimit} — a page that splits is read at ` +
        `2 · default.limit, a step of headroom over the rows it holds.`,
    );
  }
  const contributed = spec.contributed === true;
  const arms: LiveArms | null = spec.arms ?? null;
  // A contributed collection's rows carry `$columns` beside the author's
  // fields: declared on the row schema (so every parse keeps it), never bound
  // to a column (the server folds the contributors' projections into it). A
  // union's rows carry its arms' own columns the same way.
  const row =
    contributed || arms !== null ? withColumnsSchema(key, spec.row) : spec.row;
  const columnScope = spec.columnScope ?? null;
  if (columnScope !== null && columnScope.length === 0) {
    throw new Error(`liveCollection("${key}"): \`columnScope\` is empty`);
  }
  const codec = createLiveQueryCodec<keyof F & string, S>({
    key,
    id: spec.id,
    scroll,
    contributed,
    columnScope,
    arms: arms !== null,
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
  // A scroll window's rows carry the server-minted `$key` beside the row
  // fields: declared on the wire schema (so the runtime's parse keeps it), and
  // split off by every read before rows reach a consumer.
  // A scoped collection's window rows carry `$scoped` beside them when the
  // tuple orders by a scoped column (the member values its order signature
  // reads) — declared the same way, split off the same way.
  const windowKeys: Record<string, z.ZodTypeAny> = {
    ...(scroll ? { [LIVE_ROW_KEY]: z.string().nullable() } : {}),
    ...(columnScope !== null
      ? { [LIVE_SCOPED_KEY]: z.record(z.string(), z.unknown()).optional() }
      : {}),
  };
  const windowRow: ZodParser<Row> =
    Object.keys(windowKeys).length > 0
      ? (z.intersection(
          row as unknown as z.ZodTypeAny,
          z.object(windowKeys),
        ) as unknown as ZodParser<Row>)
      : row;
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
    ...rowsPart(key, { row, id: spec.id }),
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
    scroll,
    contributed,
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
      `liveCollection("${key}"): a contributed or union collection's row must be a zod object`,
    );
  }
  if (Object.hasOwn(row.shape, LIVE_COLUMNS_KEY)) {
    throw new Error(
      `liveCollection("${key}"): "${LIVE_COLUMNS_KEY}" is reserved — the contributed (or arm) values ride under it`,
    );
  }
  return (row as unknown as z.AnyZodObject).extend({
    [LIVE_COLUMNS_KEY]: z.record(z.string(), z.record(z.string(), z.unknown())),
  }) as unknown as LiveRowSchema<Row>;
}
