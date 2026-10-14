import type {
  ExternalResource,
  KeyedResourceContract,
  ResourceContract,
  ResourceMode,
  ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import type { PointParams } from "@plugins/primitives/plugins/live-state/core";
import type {
  Filterable,
  FilterScalar,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  freshnessOf,
  mintRowKeys,
  registerPagedOf,
  registerValueOf,
  tupleKey,
  type AnyServeOptions,
  type ExternalServed,
  type LiveRuntime,
  type LiveValueChanges,
  type LiveValueSource,
  type PagedChanges,
  type ServedFor,
  type ServedValueBase,
  type ServePagedValueOptions,
  type ServeValueOptions,
  type SnapshotPairing,
} from "./compile-value";
import type { LIVE_COLUMNS_KEY } from "./live-columns";
import type {
  LiveAllCollection,
  LiveCollection,
  LiveCountDescriptor,
  LiveLookupCollection,
} from "./live-collection";
import type {
  LiveKeyDirection,
  LivePagedPages,
  LivePagedValue,
  LiveQueryValue,
  LiveValue,
  LiveValueOrigin,
} from "./live-value";
import type {
  LiveCountParams,
  LiveDecodedCountQuery,
  LiveDecodedGroupQuery,
  LiveDecodedQuery,
  LiveGroup,
  LiveGroupParams,
  LiveWindowParams,
} from "./query";
import type { LivePagedParams, LiveQueryParams } from "./query-value";
import type { LiveCutKey } from "./row-key";

// The ONE serving code path every host of the live API runs — the Bun server
// (`network/live/server`), central (`network/live/central`) and any other
// host holding a `ResourceRuntime` (a browser server). A host contributes
// only its runtime (`LiveRuntime`) and which arms it can serve
// (`LiveHost.sources`); everything else — registering, the served object,
// `notify` by params or by question, a paged value's meta, an external
// collection's checks and `$key` minting — is here, so the hosts cannot drift.
// The host wrappers stay thin: the Bun server adds its `Resource.Declare`
// contributions (and a param'd preload's boot tuples); central adds nothing.

/**
 * Which `source` arms a host serves: the Bun server has a change feed
 * (`"db+external"`); central and a browser server have none (`"external"`).
 */
export type LiveHostSources = "db+external" | "external";

/** The `source` a host's `sources` admits (the type `serveValueOn` narrows `opts.source` to). */
export type LiveHostSource<H extends LiveHostSources> = H extends "external"
  ? "external"
  : LiveValueSource;

/** A host's serving capabilities, passed beside its runtime. */
export interface LiveHost<H extends LiveHostSources> {
  sources: H;
}

/**
 * A value served on a host, before the host shapes it: the runtime resource's
 * public fields plus what `serveValue` records, and — only for a
 * `"notified"` external value — `notify(subject)` (its params; the question
 * of a typed-query value).
 */
export type ServedValueOn<
  T,
  P extends Record<string, string>,
> = ServedValueBase<T, P> & {
  notify?: (subject?: unknown) => void;
};

/**
 * A paged value served on a host: its pages, its meta sibling (`null` unless
 * declared `paged.meta`) and — `"notified"` only — `notify(query)` reaching
 * every subscribed page of the question and its meta tuple.
 */
export type ServedPagedOn = ServedValueBase<unknown[], LivePagedParams> & {
  meta: ServedValueBase<unknown, LiveQueryParams> | null;
  notify?: (query: unknown) => void;
};

/** The options a host's `serveValue` hands down, erased, with `source` narrowed to its arms. */
export type ServeValueOnOptions<H extends LiveHostSources> = AnyServeOptions & {
  source: LiveHostSource<H>;
};

/** The source arm refused for a cast past {@link LiveHostSource}. */
function checkHostSource(
  where: string,
  source: unknown,
  host: LiveHost<LiveHostSources>,
): void {
  if (host.sources === "external" && source !== "external") {
    // Unreachable from typed code: `LiveHostSource<"external">`.
    throw new Error(
      `${where}: this host serves only \`source: "external"\` — it has no ` +
        `change feed to drive a \`source: ${JSON.stringify(source)}\` value.`,
    );
  }
}

/**
 * Serve a `liveValue` on `rt` — the body every host's `serveValue` runs. The
 * host's own overloads type the options against the declaration (a host's
 * `serveValue` keeps its public signature); this takes them erased, with
 * `source` narrowed to what the host serves (`host.sources`) — and refuses a
 * cast past it at runtime.
 *
 * ```ts
 * // central: (v, o) => serveValueOn(centralRuntime, v, o, { sources: "external" })
 * ```
 */
export function serveValueOn<H extends LiveHostSources>(
  rt: LiveRuntime,
  // biome-ignore lint/suspicious/noExplicitAny: a generic item's schema is invariant — erased, as page-source's `AnyPagedValue` is.
  value: LivePagedPages<any, any, any, LiveValueOrigin>,
  opts: ServeValueOnOptions<H>,
  host: LiveHost<H>,
): ServedPagedOn;
export function serveValueOn<
  T,
  P extends Record<string, string>,
  H extends LiveHostSources,
>(
  rt: LiveRuntime,
  value: LiveValue<T, P, LiveValueOrigin>,
  opts: ServeValueOnOptions<H>,
  host: LiveHost<H>,
): ServedValueOn<T, P>;
export function serveValueOn<T, P extends Record<string, string>>(
  rt: LiveRuntime,
  value:
    | LiveValue<T, P, LiveValueOrigin>
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    | LivePagedPages<any, any, any, LiveValueOrigin>,
  opts: ServeValueOnOptions<LiveHostSources>,
  host: LiveHost<LiveHostSources>,
): ServedValueOn<T, P> | ServedPagedOn {
  checkHostSource(`serveValue("${value.key}")`, opts.source, host);
  // A paged value's pages are the one keyed value (a keyed window each).
  if (value.keyed !== undefined) {
    return servePagedOn(
      rt,
      value as unknown as LivePagedValue<
        unknown,
        unknown,
        unknown,
        unknown,
        LiveValueOrigin
      >,
      opts,
    );
  }
  const plain = value as LiveValue<T, P, LiveValueOrigin>;
  // Erased: the host's overloads checked the options against the
  // declaration's form, and the compilation dispatches on the declaration.
  const { resource, compiled } = registerValueOf<T, P, unknown>(
    rt,
    plain,
    opts,
  );
  const base: ServedValueBase<T, P> = {
    key: resource.key,
    mode: resource.mode,
    schema: resource.schema,
    ...(resource.preload !== undefined ? { preload: resource.preload } : {}),
    load: (params: P) => resource.load(params),
    source: opts.source,
    ...(compiled.changes !== undefined ? { changes: compiled.changes } : {}),
    ...(compiled.unbounded !== undefined
      ? { unbounded: compiled.unbounded }
      : {}),
    keys: [plain.key],
  };
  if ("notify" in resource && compiled.changes === "notified") {
    const queried = (plain as { query?: unknown }).query !== undefined;
    return {
      ...base,
      // Only the params: `affectedIds` is a keyed concept. The runtime
      // canonicalizes them, so a notify reaches the tuple a read subscribed
      // however an absent optional param is spelled (`undefined`, `""`, left
      // out). A query value is notified by its QUESTION, which reaches the
      // one tuple the codec spells it as.
      notify: queried
        ? (query?: unknown) => {
            for (const tuple of compiled.tuplesOf(query)) {
              resource.notify(tuple);
            }
          }
        : (params?: unknown) => resource.notify(params as P | undefined),
    };
  }
  // A fresh object rather than the runtime's own: that one carries a working
  // `notify` its type merely hides, and a Postgres-backed value is driven by
  // the change feed alone — so the db arm has no `notify`, at runtime too;
  // nor has an immutable, fixed or snapshot external value (no change signal).
  return base;
}

/** A paged value: its pages and — declared `paged.meta` — its meta sibling, over one per-question lifecycle. */
function servePagedOn(
  rt: LiveRuntime,
  value: LivePagedValue<unknown, unknown, unknown, unknown, LiveValueOrigin>,
  opts: AnyServeOptions,
): ServedPagedOn {
  const { resource, compiled, meta } = registerPagedOf(rt, value, opts);
  const changes = compiled.changes;
  const base: ServedPagedOn = {
    key: resource.key,
    mode: resource.mode,
    schema: resource.schema,
    load: (params: LivePagedParams) => resource.load(params),
    source: "external",
    ...(changes !== undefined ? { changes } : {}),
    keys: [value.key, ...(meta === null ? [] : [meta.resource.key])],
    meta:
      meta === null
        ? null
        : {
            key: meta.resource.key,
            mode: meta.resource.mode,
            schema: meta.resource.schema,
            load: (params: LiveQueryParams) => meta.resource.load(params),
            source: "external",
            ...(changes !== undefined ? { changes } : {}),
            keys: [meta.resource.key],
          },
  };
  // Only a `"notified"` value is told of a change.
  if (changes !== "notified") return base;
  return {
    ...base,
    notify(query: unknown) {
      for (const tuple of compiled.tuplesOf(query)) resource.notify(tuple);
      if (meta === null) return;
      for (const tuple of meta.compiled.tuplesOf(query)) {
        meta.resource.notify(tuple);
      }
    },
  };
}

// ── External collections ───────────────────────────────────────────────
// A `liveCollection` whose rows live OUTSIDE Postgres (an in-memory list, a
// demo pack, a provider), served through the same minted descriptors a
// table-backed one is — so `useLive` reads it unchanged. The source answers
// each minted resource's question by hand:
//
// - a window collection: `window(q)` — the decoded window query `{ limit,
//   where?, orderBy, after?, until? }` → its rows, filtered, ordered and
//   cut by the source; `rows(ids)`; `groups?(q)`; `count(q)` exactly when
//   declared `count: true`;
// - an `all` collection: `all()` (every row, in the declared order) and
//   `rows(ids)`;
// - a lookup-only collection: `rows(ids)`.
//
// The window compiles to the runtime's external keyed window (its size and
// family from the collection's own codec), `:rows` to the external point arm
// (its ids from the point codec), `key` of an `all` collection to an external
// window holding the whole set, and `:groups` / `:count` to plain external
// push values. Every answer is checked against the declaration (the row
// schema, field by field; the ids; the size asked), and a scroll window's rows
// are minted their `$key` — the one check a paged value's page runs
// (`mintRowKeys`). Nothing is routed: a change arrives as `notify` (D31).

/** How an external collection's rows change: a value's arms, never a snapshot. */
export type LiveCollectionChanges = Exclude<
  LiveValueChanges,
  { snapshot: unknown }
>;

/** An answer a source may compute synchronously or not. */
type Answer<T> = Promise<T> | T;

/**
 * A collection whose rows carry another plugin's columns (`$columns`: a
 * contributed, exposing or union collection) folds them from Postgres joins —
 * it has no external spelling (tsc; a throw for a cast, and for a
 * `columnScope`, which no type tells apart).
 */
type Unfolded<Row> = typeof LIVE_COLUMNS_KEY extends keyof Row
  ? {
      readonly __externalCollection: "a contributed, exposing or union collection folds Postgres-served columns — serve it from a table";
    }
  : unknown;

/** The window collections an external source serves: single-table, nothing folded in. */
export type ExternalWindowCollection<
  Row,
  F,
  S extends string,
  Sc extends boolean,
  Cn,
> = LiveCollection<Row, F, S> & {
  arms: null;
  scroll: Sc;
  count: Cn;
} & Unfolded<Row>;

/** An `all` collection an external source serves: nothing folded in. */
export type ExternalAllCollection<Row> = LiveAllCollection<Row> & Unfolded<Row>;

/** A lookup-only collection an external source serves: nothing folded in. */
export type ExternalLookupCollection<Row> = LiveLookupCollection<Row> &
  Unfolded<Row>;

/** A sortable field whose row type is not text: its `$key` part needs `keyText`. */
type NonTextSortable<Row, S extends string> = {
  [K in S & keyof Row]: [Row[K]] extends [string | null] ? never : K;
}[S & keyof Row];

/** Per sortable field, the exact text a scroll window's `$key` holds for its value. */
type KeyTextMap<Row, S extends string> = {
  [K in S & keyof Row]?: (value: Row[K]) => string | null;
};

/**
 * A scroll window mints each row's `$key` from its order fields' TEXT, whose
 * code-point order must be the source's order (a page is cut there, and the
 * served half checks every answer is in it). A text field is its own text; any
 * other sortable field needs `keyText.<field>` (tsc) — the source supplies the
 * precision, as Postgres `::text` does for a table (an instant at a fixed
 * precision, a zero-padded number). A non-scroll window mints no key.
 */
type KeyTextOption<Row, S extends string, Sc extends boolean> = [Sc] extends [
  true,
]
  ? [NonTextSortable<Row, S>] extends [never]
    ? { keyText?: KeyTextMap<Row, S> }
    : {
        keyText: KeyTextMap<Row, S> & {
          [K in NonTextSortable<Row, S>]-?: (value: Row[K]) => string | null;
        };
      }
  : { keyText?: never };

/** `count(q)` exactly when the collection is declared `count: true`. */
type CountOption<Cn> = [Cn] extends [null]
  ? { count?: never }
  : {
      /** How many rows match `q.where` — the window's rows, uncut and unlimited. */
      count: (q: LiveDecodedCountQuery) => Answer<number>;
    };

/** What every external collection form takes. */
interface ExternalCollectionBase<Row, C extends LiveCollectionChanges> {
  /** The truth lives outside Postgres; a change arrives as `notify` (or never — `changes`). */
  source: "external";
  /**
   * How the rows change: `"notified"` — the served collection has `notify` —
   * or `{ immutable | fixed: { reason } }`, with none.
   */
  changes: C;
  /** The rows with these ids (any order; an id it cannot find is absent). */
  rows: (ids: readonly string[]) => Answer<readonly Row[]>;
}

/** An external window collection's answers (see the section header). */
export type ServeExternalWindowOptions<
  Row,
  F,
  S extends string,
  Sc extends boolean,
  Cn,
  C extends LiveCollectionChanges,
> = ExternalCollectionBase<Row, C> & {
  /** The window `q` asks for: its rows matching `q.where`, in `q.orderBy` (the id breaking ties), inside `(q.after, q.until]`, at most `q.limit`. */
  window: (q: LiveDecodedQuery<S>) => Answer<readonly Row[]>;
  /** The values `q.groupBy` takes over the rows matching `q.where`, with counts — count descending, then value; at most `q.limit`. Absent: `:groups` is not served. */
  groups?: (
    q: LiveDecodedGroupQuery<keyof F & string>,
  ) => Answer<readonly LiveGroup<FilterScalar>[]>;
  all?: never;
} & CountOption<Cn> &
  KeyTextOption<Row, S, Sc>;

/** An external `all` collection's answers: every row, in the declared order. */
export type ServeExternalAllOptions<
  Row,
  C extends LiveCollectionChanges,
> = ExternalCollectionBase<Row, C> & {
  all: () => Answer<readonly Row[]>;
  window?: never;
  groups?: never;
  count?: never;
  keyText?: never;
};

/** An external lookup-only collection's one answer: rows by id. */
export type ServeExternalLookupOptions<
  Row,
  C extends LiveCollectionChanges,
> = ExternalCollectionBase<Row, C> & {
  all?: never;
  window?: never;
  groups?: never;
  count?: never;
  keyText?: never;
};

/**
 * A served external resource's public half — a fresh object, so a silent
 * collection's handles carry no working `notify` its type hides.
 */
export interface ServedExternalResource<T, P extends ResourceParams> {
  key: string;
  mode: ResourceMode;
  preload?: "boot" | "boot-and-keep";
  load(params: P): Promise<T>;
}

/**
 * A change to tell a `"notified"` external collection of: nothing (every
 * subscribed tuple of every minted resource re-reads), or the ids of the rows
 * that changed — then a `:rows` tuple re-reads only when its id set holds one
 * of them, while every window, `all`, `:groups` and `:count` tuple still
 * re-reads (a changed row may enter or leave any of them; only the source
 * could say which). A re-read that changes nothing ships an empty delta.
 */
export interface LiveCollectionChange {
  ids: readonly string[];
}

/** What every served external collection carries. */
interface ServedExternalBase {
  source: "external";
  changes: LiveCollectionChanges;
  /** Every registered key, in mint order. */
  keys: string[];
  /** Every registered resource, in `keys` order — what a host declares. */
  resources: ServedExternalResource<unknown, ResourceParams>[];
}

/** `notify` on a `"notified"` collection, nothing on a silent one. */
type NotifyArm<C> = ServedFor<
  C,
  { notify(change?: LiveCollectionChange): void },
  unknown
>;

/** A served external window collection. */
export type ServedExternalWindow<
  Row,
  C extends LiveCollectionChanges = LiveCollectionChanges,
> = ServedExternalBase & {
  window: ServedExternalResource<Row[], LiveWindowParams>;
  rows: ServedExternalResource<Row[], PointParams>;
  /** `null` when served without `groups`. */
  groups: ServedExternalResource<
    LiveGroup<FilterScalar>[],
    LiveGroupParams
  > | null;
  /** `null` unless declared `count: true`. */
  count: ServedExternalResource<number, LiveCountParams> | null;
} & NotifyArm<C>;

/** A served external `all` collection. */
export type ServedExternalAll<
  Row,
  C extends LiveCollectionChanges = LiveCollectionChanges,
> = ServedExternalBase & {
  all: ServedExternalResource<Row[], Record<string, never>>;
  rows: ServedExternalResource<Row[], PointParams>;
} & NotifyArm<C>;

/** A served external lookup-only collection. */
export type ServedExternalLookup<
  Row,
  C extends LiveCollectionChanges = LiveCollectionChanges,
> = ServedExternalBase & {
  rows: ServedExternalResource<Row[], PointParams>;
} & NotifyArm<C>;

/**
 * Serve a `liveCollection` from an external source on `rt` (any host — the
 * table-backed arm is the Bun `serveCollection`'s). See the section header.
 *
 * ```ts
 * const served = serveCollectionOn(rt, orders, {
 *   source: "external",
 *   changes: "notified",
 *   window: (q) => store.window(q),          // filtered, ordered, cut, ≤ q.limit
 *   rows: (ids) => store.byIds(ids),
 *   groups: (q) => store.groups(q),          // optional
 * });
 * served.notify({ ids: ["o1"] });            // or notify(): every tuple
 * ```
 */
export function serveCollectionOn<
  Row,
  const C extends LiveCollectionChanges = "notified",
>(
  rt: LiveRuntime,
  collection: ExternalAllCollection<Row>,
  opts: ServeExternalAllOptions<NoInfer<Row>, C>,
): ServedExternalAll<Row, C>;
export function serveCollectionOn<
  Row,
  const C extends LiveCollectionChanges = "notified",
>(
  rt: LiveRuntime,
  collection: ExternalLookupCollection<Row>,
  opts: ServeExternalLookupOptions<NoInfer<Row>, C>,
): ServedExternalLookup<Row, C>;
export function serveCollectionOn<
  Row,
  F,
  S extends string,
  Sc extends boolean,
  Cn,
  const C extends LiveCollectionChanges = "notified",
>(
  rt: LiveRuntime,
  collection: ExternalWindowCollection<Row, F, S, Sc, Cn>,
  opts: ServeExternalWindowOptions<
    NoInfer<Row>,
    NoInfer<F>,
    NoInfer<S>,
    NoInfer<Sc>,
    NoInfer<Cn>,
    C
  >,
): ServedExternalWindow<Row, C>;
export function serveCollectionOn(
  rt: LiveRuntime,
  collection: AnyCollection,
  opts: AnyExternalCollectionOptions,
): AnyServedExternal {
  return compileExternalCollection(rt, collection, opts);
}

/** Every served form, erased — the implementation's view. */
export type AnyServedExternal = ServedExternalBase & {
  window?: ServedExternalResource<unknown[], LiveWindowParams>;
  all?: ServedExternalResource<unknown[], Record<string, never>>;
  rows: ServedExternalResource<unknown[], PointParams>;
  groups?: ServedExternalResource<
    LiveGroup<FilterScalar>[],
    LiveGroupParams
  > | null;
  count?: ServedExternalResource<number, LiveCountParams> | null;
  notify?: (change?: LiveCollectionChange) => void;
};

/** Every collection form, erased — the implementation's view. */
export type AnyCollection = {
  key: string;
  id: string;
  row: { safeParse(v: unknown): ZodSafeParse; shape: Record<string, unknown> };
  rowKeys: readonly string[];
  rows: KeyedResourceContract<unknown[], PointParams> & {
    point: { decode: (params: Record<string, string>) => string[] };
  };
  all?: KeyedResourceContract<unknown[], Record<string, never>> | undefined;
  window?: KeyedResourceContract<unknown[], LiveWindowParams> & {
    window: {
      decode: (params: Record<string, string>) => LiveDecodedQuery<string>;
      familyOf: (params: LiveWindowParams) => string;
    };
  };
  groups?: ResourceContract<unknown[], LiveGroupParams> & {
    groups: {
      decode: (params: Record<string, string>) => LiveDecodedGroupQuery<string>;
    };
  };
  count?: LiveCountDescriptor<Filterable> | null;
  filterable?: unknown;
  scroll?: boolean;
  contributed?: boolean;
  columnScope?: string | null;
  arms?: unknown;
  exposes?: unknown;
};

type ZodSafeParse =
  | { success: true }
  | {
      success: false;
      error: { issues: { path: (string | number)[]; message: string }[] };
    };

/** Every external collection form's options, erased. */
export interface AnyExternalCollectionOptions {
  source: string;
  changes?: LiveCollectionChanges;
  rows: (ids: readonly string[]) => Answer<readonly unknown[]>;
  window?: (q: LiveDecodedQuery<string>) => Answer<readonly unknown[]>;
  all?: () => Answer<readonly unknown[]>;
  groups?: (
    q: LiveDecodedGroupQuery<string>,
  ) => Answer<readonly LiveGroup<FilterScalar>[]>;
  count?: (q: LiveDecodedCountQuery) => Answer<number>;
  keyText?: Record<string, ((value: unknown) => string | null) | undefined>;
}

/** The `changes` an external collection declares, checked for an untyped caller. */
function checkCollectionChanges(
  fail: (message: string) => never,
  changes: unknown,
): LiveCollectionChanges {
  if (changes === "notified") return changes;
  if (changes === undefined) {
    return fail(
      'an external collection must declare `changes` — "notified", or ' +
        "{ immutable | fixed: { reason } }.",
    );
  }
  const arms =
    typeof changes === "object" && changes !== null ? Object.keys(changes) : [];
  const arm = arms[0];
  const reason = (changes as Record<string, { reason?: unknown } | undefined>)[
    arm ?? ""
  ]?.reason;
  if (
    arms.length !== 1 ||
    (arm !== "immutable" && arm !== "fixed") ||
    typeof reason !== "string"
  ) {
    return fail(
      `\`changes\` ${JSON.stringify(changes)} is not "notified" or one of ` +
        "{ immutable | fixed: { reason } } (a collection is never a snapshot).",
    );
  }
  if (reason.trim() === "") {
    return fail(
      `\`changes.${arm}.reason\` is empty — say why this collection is never ` +
        "told of a change.",
    );
  }
  return changes as LiveCollectionChanges;
}

/** One registered resource and, on a `"notified"` collection, the tuples subscribed to it now. */
interface Registered {
  resource: ExternalResource<unknown, ResourceParams>;
  held: Map<string, ResourceParams>;
  /** A `:rows` tuple's ids — what a `notify({ ids })` narrows by. */
  idsOf?: (params: ResourceParams) => readonly string[];
}

/**
 * The external compilation, erased (see the section header) — what a host's
 * own typed overloads (the Bun `serveCollection`) dispatch to.
 */
export function compileExternalCollection(
  rt: LiveRuntime,
  collection: AnyCollection,
  opts: AnyExternalCollectionOptions,
): AnyServedExternal {
  const where = `serveCollection("${collection.key}")`;
  const fail = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  if (opts.source !== "external") {
    // Unreachable from typed code: `serveCollectionOn` serves the external arm.
    fail(
      `serveCollectionOn serves \`source: "external"\` — got ${JSON.stringify(opts.source)} (a table-backed collection is the Bun serveCollection's).`,
    );
  }
  // Typed away (`Unfolded`, `arms: null`); refused against a cast, and for a
  // column scope, which no type tells apart.
  if ((collection.arms ?? null) !== null) {
    fail(
      "a union collection (declared with `arms`) reads several tables — it has no external spelling.",
    );
  }
  if (collection.contributed === true) {
    fail(
      "a `contributed: true` collection folds other plugins' Postgres columns — it has no external spelling.",
    );
  }
  if ((collection.columnScope ?? null) !== null) {
    fail(
      "a `columnScope` collection folds scoped column sets from Postgres — it has no external spelling.",
    );
  }
  if ((collection.exposes ?? null) !== null) {
    fail(
      "an `exposes` collection folds exposed extension fields from Postgres — it has no external spelling.",
    );
  }
  const changes = checkCollectionChanges(fail, opts.changes);
  const notified = changes === "notified";
  const freshness = freshnessOf(changes);
  const form =
    collection.all !== undefined
      ? "all"
      : collection.window !== undefined
        ? "window"
        : "lookup";
  // Each form takes exactly its answers (tsc); refused for a cast.
  const allowed: readonly string[] = {
    all: ["all"],
    window: ["window", "groups", "count", "keyText"],
    lookup: [],
  }[form];
  const stray = (["window", "all", "groups", "count", "keyText"] as const)
    .filter((f) => opts[f] !== undefined && !allowed.includes(f))
    .map((f) => `\`${f}\``);
  if (stray.length > 0) {
    fail(
      `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} not answered by ${form === "lookup" ? "a lookup-only" : form === "all" ? "an `all`" : "a window"} collection.`,
    );
  }
  if (typeof opts.rows !== "function") fail("`rows(ids)` is required.");

  const registered: Registered[] = [];
  /** The subscribe hooks tracking a resource's live tuples — only a `"notified"` collection needs them. */
  const track = (): {
    held: Map<string, ResourceParams>;
    hooks: {
      onFirstSubscribe?: (params: ResourceParams) => void;
      onLastUnsubscribe?: (params: ResourceParams) => void;
    };
  } => {
    const held = new Map<string, ResourceParams>();
    return {
      held,
      hooks: notified
        ? {
            onFirstSubscribe: (params) => {
              held.set(tupleKey(params), params);
            },
            onLastUnsubscribe: (params) => {
              held.delete(tupleKey(params));
            },
          }
        : {},
    };
  };
  const keep = <T, P extends ResourceParams>(
    resource: ExternalResource<T, P>,
    held: Map<string, ResourceParams>,
    idsOf?: (params: ResourceParams) => readonly string[],
  ): ServedExternalResource<T, P> => {
    registered.push({
      resource: resource as unknown as ExternalResource<
        unknown,
        ResourceParams
      >,
      held,
      ...(idsOf !== undefined ? { idsOf } : {}),
    });
    return {
      key: resource.key,
      mode: resource.mode,
      ...(resource.preload !== undefined ? { preload: resource.preload } : {}),
      load: (params: P) => resource.load(params),
    };
  };

  /** One answer's rows, checked against the declaration and projected onto the row schema's keys. */
  const checkedRows = (
    what: string,
    answer: unknown,
    limit: number | null,
  ): Record<string, unknown>[] => {
    if (!Array.isArray(answer)) {
      fail(`${what} returned ${typeof answer}, not an array of rows.`);
    }
    const rows = answer as unknown[];
    if (limit !== null && rows.length > limit) {
      fail(`${what} returned ${rows.length} rows for at most ${limit}.`);
    }
    const seen = new Set<string>();
    return rows.map((row, i) => {
      const parsed = collection.row.safeParse(row);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        fail(
          `${what} row ${i}: field "${issue?.path.join(".") ?? "?"}" — ${issue?.message ?? "invalid"}.`,
        );
      }
      const fields = row as Record<string, unknown>;
      const id = fields[collection.id];
      if (typeof id !== "string") {
        fail(
          `${what} row ${i}: the id "${collection.id}" is ${JSON.stringify(id)}, not a string.`,
        );
      }
      if (seen.has(id as string)) {
        fail(`${what} returned the id "${id as string}" twice.`);
      }
      seen.add(id as string);
      // The projection IS the row schema — exactly its keys, as a table's.
      const out: Record<string, unknown> = {};
      for (const k of collection.rowKeys) {
        if (k in fields) out[k] = fields[k];
      }
      return out;
    });
  };

  // ── :rows (every form) ──
  const pointDecode = collection.rows.point.decode;
  const rowsTrack = track();
  const rows = keep(
    rt.defineExternalResource(collection.rows, {
      membership: { kind: "point", idsOf: (params) => pointDecode(params) },
      loader: async (params: PointParams) => {
        const ids = pointDecode(params);
        const asked = new Set(ids);
        const out = checkedRows("rows(ids)", await opts.rows(ids), ids.length);
        for (const row of out) {
          if (!asked.has(row[collection.id] as string)) {
            fail(
              `rows(ids) returned the id "${row[collection.id] as string}", which was not asked for.`,
            );
          }
        }
        return out;
      },
      ...rowsTrack.hooks,
      freshness,
    }),
    rowsTrack.held,
    (params) => pointDecode(params),
  );

  let served: Omit<AnyServedExternal, keyof ServedExternalBase | "notify">;

  if (form === "all") {
    const allAnswer = opts.all;
    if (typeof allAnswer !== "function") fail("`all()` is required.");
    const allTrack = track();
    // The whole set is one keyed tuple `{}`: an external window as wide as
    // the set (no family — nothing derives from it), its change a re-read
    // diffed by key. Its contract is keyed, so it is never a plain value.
    const all = keep(
      rt.defineExternalResource(
        collection.all as KeyedResourceContract<
          unknown[],
          Record<string, never>
        >,
        {
          membership: {
            kind: "window",
            limitOf: () => Number.MAX_SAFE_INTEGER,
          },
          loader: async () => checkedRows("all()", await allAnswer!(), null),
          ...allTrack.hooks,
          freshness,
        },
      ),
      allTrack.held,
    );
    served = { all, rows };
  } else if (form === "window") {
    const windowAnswer = opts.window;
    if (typeof windowAnswer !== "function") fail("`window(q)` is required.");
    const descriptor = collection.window!;
    const codec = descriptor.window;
    const scroll = collection.scroll === true;
    const keyText = opts.keyText ?? {};
    /** One order field's `$key` part: its text, or NULL. */
    const partOf = (row: Record<string, unknown>, field: string) => {
      const value = row[field];
      const toText = keyText[field];
      if (toText !== undefined) {
        const text = toText(value);
        if (text !== null && typeof text !== "string") {
          fail(
            `keyText.${field} returned ${JSON.stringify(text)}, not text or null.`,
          );
        }
        return text;
      }
      if (value === null || value === undefined) return null;
      if (typeof value === "string") return value;
      return fail(
        `order field "${field}" of row "${row[collection.id] as string}" is ${typeof value} — ` +
          `pass \`keyText.${field}\`: its exact text, whose code-point order is its order.`,
      );
    };
    const windowTrack = track();
    const window = keep(
      rt.defineExternalResource(descriptor, {
        // No mode: the window is keyed (its descriptor's `keyed`), sized and
        // familied by its own codec, as the paged value's pages are.
        membership: {
          kind: "window",
          limitOf: (params) => codec.decode(params).limit,
          familyOf: (params) => codec.familyOf(params as LiveWindowParams),
        },
        loader: async (params: LiveWindowParams) => {
          const q = codec.decode(params);
          const out = checkedRows("window(q)", await windowAnswer!(q), q.limit);
          if (!scroll) return out;
          // The key: the order's parts, then the id unless the order names it.
          const named = q.orderBy.some(([c]) => c === collection.id);
          const dirs: LiveKeyDirection[] = [
            ...q.orderBy.map(([, d]) => d),
            ...(named ? [] : (["asc"] as const)),
          ];
          return mintRowKeys(
            out,
            (row): LiveCutKey => [
              ...q.orderBy.map(([c]) =>
                c === collection.id
                  ? (row[collection.id] as string)
                  : partOf(row, c),
              ),
              ...(named ? [] : [row[collection.id] as string]),
            ],
            dirs,
            { after: q.after ?? null, until: q.until ?? null },
            (detail) => fail(`window(q): ${detail}`),
          );
        },
        ...windowTrack.hooks,
        freshness,
      }),
      windowTrack.held,
    );

    let groups: AnyServedExternal["groups"] = null;
    const groupsAnswer = opts.groups;
    if (groupsAnswer !== undefined && collection.groups !== undefined) {
      const groupCodec = collection.groups.groups;
      const groupsTrack = track();
      groups = keep(
        rt.defineExternalResource(
          collection.groups as ResourceContract<
            LiveGroup<FilterScalar>[],
            LiveGroupParams
          > & { keyed?: never },
          {
            mode: "push",
            loader: async (params: LiveGroupParams) => {
              const q = groupCodec.decode(params);
              return checkedGroups(fail, collection, q, await groupsAnswer(q));
            },
            ...groupsTrack.hooks,
            freshness,
          },
        ),
        groupsTrack.held,
      );
    }

    let count: AnyServedExternal["count"] = null;
    const countDescriptor = collection.count ?? null;
    if ((countDescriptor === null) !== (opts.count === undefined)) {
      // Unreachable from typed code (`CountOption`).
      fail(
        countDescriptor === null
          ? "`count` is served only for a collection declared `count: true`."
          : "the collection is declared `count: true` — serve it with `count(q)`.",
      );
    }
    const countAnswer = opts.count;
    if (countDescriptor !== null && countAnswer !== undefined) {
      const countTrack = track();
      count = keep(
        rt.defineExternalResource(
          countDescriptor as unknown as ResourceContract<
            number,
            LiveCountParams
          > & { keyed?: never },
          {
            mode: "push",
            loader: async (params: LiveCountParams) => {
              const n = await countAnswer(countDescriptor.count.decode(params));
              if (!Number.isSafeInteger(n) || n < 0) {
                fail(`count(q) returned ${JSON.stringify(n)}, not a count.`);
              }
              return n;
            },
            ...countTrack.hooks,
            freshness,
          },
        ),
        countTrack.held,
      );
    }
    served = { window, rows, groups, count };
  } else {
    served = { rows };
  }

  const resources = registered.map((r) => ({
    key: r.resource.key,
    mode: r.resource.mode,
    ...(r.resource.preload !== undefined
      ? { preload: r.resource.preload }
      : {}),
    load: (params: ResourceParams) => r.resource.load(params),
  }));
  const base: AnyServedExternal = {
    ...served,
    source: "external",
    changes,
    keys: registered.map((r) => r.resource.key),
    resources,
  };
  // No change signal ⇒ no `notify`, at runtime too.
  if (!notified) return base;
  return {
    ...base,
    notify(change?: LiveCollectionChange) {
      const ids = change === undefined ? null : new Set(change.ids);
      for (const r of registered) {
        for (const params of r.held.values()) {
          if (
            ids !== null &&
            r.idsOf !== undefined &&
            !r.idsOf(params).some((id) => ids.has(id))
          ) {
            continue;
          }
          r.resource.notify(params);
        }
      }
    },
  };
}

/**
 * A grouping's answer, checked: at most `q.limit` groups, each a value the
 * row field can hold (NULL its own group) and a positive count, count
 * descending — the order a table's grouping has.
 */
function checkedGroups(
  fail: (message: string) => never,
  collection: AnyCollection,
  q: LiveDecodedGroupQuery<string>,
  answer: unknown,
): LiveGroup<FilterScalar>[] {
  if (!Array.isArray(answer)) {
    fail(`groups(q) returned ${typeof answer}, not an array of groups.`);
  }
  const groups = answer as LiveGroup<FilterScalar>[];
  if (groups.length > q.limit) {
    fail(`groups(q) returned ${groups.length} groups for at most ${q.limit}.`);
  }
  const field = collection.row.shape[q.groupBy] as
    { safeParse(v: unknown): ZodSafeParse } | undefined;
  let previous = Number.POSITIVE_INFINITY;
  return groups.map((g, i) => {
    if (!Number.isSafeInteger(g.count) || g.count <= 0) {
      fail(
        `groups(q) group ${i}: count ${JSON.stringify(g.count)} is not a positive count.`,
      );
    }
    if (g.count > previous) {
      fail(`groups(q) is not ordered count descending (group ${i}).`);
    }
    previous = g.count;
    if (g.value !== null && field !== undefined) {
      const parsed = field.safeParse(g.value);
      if (!parsed.success) {
        fail(
          `groups(q) group ${i}: ${JSON.stringify(g.value)} is not a value of field "${q.groupBy}" — ${parsed.error.issues[0]?.message ?? "invalid"}.`,
        );
      }
    }
    return { value: g.value, count: g.count };
  });
}

// ── A host's typed external-arm surface ─────────────────────────────

/** A value served on the external arm with no change signal (immutable / fixed / snapshot). */
export type ExternalSilentValue<
  T,
  P extends Record<string, string>,
> = ServedValueBase<T, P> & {
  source: "external";
  changes: LiveValueChanges;
};

/** A `changes: "notified"` external value: `notify(params)` recomputes (and pushes) that tuple — `{}` when omitted. */
export type ExternalNotifiedValue<
  T,
  P extends Record<string, string>,
> = ExternalSilentValue<T, P> & {
  notify(params?: P): void;
};

/** A `"notified"` external typed-query value: `notify(query)` reaches its question's tuple. */
export type ExternalNotifiedQueryValue<
  T,
  P extends Record<string, string>,
  Q,
> = ExternalSilentValue<T, P> & {
  notify(query: Q): void;
};

/** An external paged value declared `changes: { immutable | fixed }`: its pages and its meta sibling, no `notify`. */
export type ExternalSilentPagedValue<Item> = ServedValueBase<
  Item[],
  LivePagedParams
> & {
  source: "external";
  changes: LiveValueChanges;
  meta: ServedValueBase<unknown, LiveQueryParams> | null;
};

/** A `"notified"` external paged value: `notify(query)` reaches every subscribed page of the question and its meta. */
export type ExternalNotifiedPagedValue<Item, Q> =
  ExternalSilentPagedValue<Item> & {
    notify(query: Q): void;
  };

/**
 * The external arm of `serveValue` and `serveCollection`, typed against the
 * declaration, for values of origin `O` — what a host with no change feed and
 * no plugin-boot declare step hands its caller (a browser server's `serve`
 * callback). Implemented by binding {@link serveValueOn} (`sources:
 * "external"`) and {@link serveCollectionOn} to the host's runtime.
 */
export interface LiveExternalServe<O extends LiveValueOrigin> {
  serveValue: {
    <
      Item,
      Meta,
      Q,
      QIn,
      const R extends readonly ExternalServed[] = [],
      C extends PagedChanges = "notified",
      K extends string = never,
    >(
      value: LivePagedValue<Item, Meta, Q, QIn, O, K>,
      opts: ServePagedValueOptions<
        NoInfer<Item>,
        NoInfer<Meta>,
        NoInfer<Q>,
        R,
        C
      >,
    ): ServedFor<
      C,
      ExternalNotifiedPagedValue<Item, Q>,
      ExternalSilentPagedValue<Item>
    >;
    <
      T,
      Q,
      QIn,
      const R extends readonly ExternalServed[] = [],
      C extends LiveValueChanges = "notified",
    >(
      value: LiveQueryValue<T, Q, QIn, O> & SnapshotPairing<C>,
      opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "external", R, C>,
    ): ServedFor<
      C,
      ExternalNotifiedQueryValue<T, LiveQueryParams, Q>,
      ExternalSilentValue<T, LiveQueryParams>
    >;
    <
      T,
      P extends Record<string, string>,
      const R extends readonly ExternalServed[] = [],
      C extends LiveValueChanges = "notified",
    >(
      value: LiveValue<T, P, O> & { query?: undefined } & SnapshotPairing<C>,
      opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "external", R, C>,
    ): ServedFor<C, ExternalNotifiedValue<T, P>, ExternalSilentValue<T, P>>;
  };
  serveCollection: {
    <Row, const C extends LiveCollectionChanges = "notified">(
      collection: ExternalAllCollection<Row>,
      opts: ServeExternalAllOptions<NoInfer<Row>, C>,
    ): ServedExternalAll<Row, C>;
    <Row, const C extends LiveCollectionChanges = "notified">(
      collection: ExternalLookupCollection<Row>,
      opts: ServeExternalLookupOptions<NoInfer<Row>, C>,
    ): ServedExternalLookup<Row, C>;
    <
      Row,
      F,
      S extends string,
      Sc extends boolean,
      Cn,
      const C extends LiveCollectionChanges = "notified",
    >(
      collection: ExternalWindowCollection<Row, F, S, Sc, Cn>,
      opts: ServeExternalWindowOptions<
        NoInfer<Row>,
        NoInfer<F>,
        NoInfer<S>,
        NoInfer<Sc>,
        NoInfer<Cn>,
        C
      >,
    ): ServedExternalWindow<Row, C>;
  };
}

/**
 * Bind the external arm to a host's runtime: `serveValue` is
 * {@link serveValueOn} (`sources: "external"`) and `serveCollection`
 * {@link serveCollectionOn}, both on `rt`, typed by {@link LiveExternalServe}.
 * For a host that is not a plugin runtime and hands its caller this surface
 * (a browser server's `serve` callback). `origin` is the one origin this host
 * serves — a value of the other origin throws (its readers subscribe on the
 * other socket, so serving it here would answer nobody).
 */
export function bindExternalServe<O extends LiveValueOrigin>(
  rt: LiveRuntime,
  origin: O,
): LiveExternalServe<O> {
  const serveValue = (
    value:
      | LiveValue<unknown, Record<string, string>, LiveValueOrigin>
      // biome-ignore lint/suspicious/noExplicitAny: a generic item's schema is invariant — erased, as page-source's `AnyPagedValue` is.
      | LivePagedPages<any, any, any, LiveValueOrigin>,
    opts: AnyServeOptions,
  ): ServedValueOn<unknown, Record<string, string>> | ServedPagedOn => {
    const valueOrigin = value.origin ?? "worktree";
    if (valueOrigin !== origin) {
      throw new Error(
        `serveValue("${value.key}"): a ${valueOrigin} value — this host serves ${origin} values only.`,
      );
    }
    return serveValueOn(
      rt,
      value as LiveValue<unknown, Record<string, string>, LiveValueOrigin>,
      opts as ServeValueOnOptions<"external">,
      { sources: "external" },
    );
  };
  const serveCollection = (
    collection: AnyCollection,
    opts: AnyExternalCollectionOptions,
  ): AnyServedExternal => compileExternalCollection(rt, collection, opts);
  // Erased: the interface's overloads check each call against its
  // declaration; both bodies dispatch on the declaration itself.
  return {
    serveValue: serveValue as LiveExternalServe<O>["serveValue"],
    serveCollection: serveCollection as LiveExternalServe<O>["serveCollection"],
  };
}
