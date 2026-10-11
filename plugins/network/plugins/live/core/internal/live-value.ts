import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import {
  registerResourceDescriptor,
  type ResourceDescriptor,
  type ResourcePreload,
} from "@plugins/primitives/plugins/live-state/core";
import type { LivePreload, LiveRowSchema } from "./live-collection";
import {
  liveQueryCodec,
  livePagedCodec,
  type LivePagedCodec,
  type LivePagedParams,
  type LiveQueryCodec,
  type LiveQueryParams,
  type LiveQuerySchema,
} from "./query-value";
import { LIVE_ROW_KEY, type LiveCutKey } from "./row-key";

// `liveValue` — the declaration half of a live VALUE: one payload per params
// tuple, pushed whole whenever it changes — or, with `load: "on-demand"`,
// refetched over HTTP by each tab (the server half is `serveValue`, the read is
// `useLive(value, params?)`). The delivery mode is declared HERE, not on
// `serveValue`: the client reads it too, so it lives on the one declaration
// both halves share and they cannot disagree. A value has no rows, no window and no id
// set; anything row-shaped and growing is a `liveCollection`.
//
// Not known yet is a STATE: a value declares no `initial` placeholder. Its read
// is `pending` until the first authoritative value lands — or settled on its
// first render when the boot snapshot preloaded it.

/** A declared param name without its optional marker: `"scopeId?"` → `"scopeId"`. */
type RequiredParamName<N extends string> = N extends `${string}?` ? never : N;
type OptionalParamName<N extends string> = N extends `${infer B}?` ? B : never;

/**
 * The params object a value's declared param names derive: every name → a
 * string, and a name declared with a trailing `?` (`"scopeId?"`) → an optional
 * one. An optional param is present iff it is a non-empty string: the
 * substrate drops an `undefined` or `""` one wherever params enter it
 * (`canonicalParams`), so `{ path }` and `{ path, scopeId: undefined }` name
 * one tuple.
 */
export type LiveValueParams<N extends readonly string[]> = Simplify<
  { [R in RequiredParamName<N[number]>]: string } & {
    [O in OptionalParamName<N[number]>]?: string;
  }
>;

/**
 * A TYPED params declaration: each param name → the parser its wire string
 * must pass (`{ window: z.enum(LATENCY_WINDOWS) }`). The parser narrows the
 * string — it never changes it: its output is a `string` (tsc), and at
 * declaration a transforming, refining-by-effect, defaulting or catching
 * parser (`ZodEffects` / `ZodDefault` / `ZodCatch` anywhere in it, or a
 * rewriting string check — `.trim()` / `.toLowerCase()` / `.toUpperCase()`)
 * and one that accepts `undefined` are refused (a throw). So the value the loader
 * receives IS the wire string the client sent, and the runtime's tuple key is
 * unchanged. Every name is required: an optional typed param has no consumer
 * yet.
 */
export type LiveValueParamParsers = Readonly<Record<string, ZodParser<string>>>;

/** The params object a typed declaration derives: each name → its parser's output. */
export type LiveTypedValueParams<R extends LiveValueParamParsers> = {
  [K in keyof R & string]: z.output<R[K]>;
};

/**
 * Refuses (tsc) a parsers record typed with an index signature
 * (`Record<string, z.ZodString>`, `LiveValueParamParsers`): its derived `P`
 * would be `{ [k: string]: string }`, which `useLive` reads as param-less —
 * a read the runtime gate always refuses, since every typed name is required.
 */
type LiteralParamNames<R> = string extends keyof R
  ? { params: never }
  : unknown;

/** One object type out of an intersection (keeps each key's `?`). */
type Simplify<T> = { [K in keyof T]: T[K] };

/**
 * Which process serves a value: a worktree backend (the default), or the
 * machine-wide central runtime (shared by every worktree — auth). The browser
 * picks the socket from the descriptor's `origin`, and each `serveValue` accepts
 * only its own origin (tsc).
 */
export type LiveValueOrigin = "worktree" | "central";

/**
 * The descriptor's `origin` for `O`: required `"central"` on a central value,
 * absent on a worktree one — so neither is assignable to the other.
 */
type OriginField<O extends LiveValueOrigin> = O extends "central"
  ? { origin: "central" }
  : { origin?: never };

/**
 * What every declared value is, whatever its delivery: a `ResourceDescriptor`
 * discriminated from a collection by `live: "value"`.
 */
type LiveValueBase<
  T,
  P extends Record<string, string>,
  O extends LiveValueOrigin,
> = Omit<ResourceDescriptor<T, P>, "keyed" | "preload" | "origin" | "load"> &
  OriginField<O> & {
    live: "value";
    /**
     * The declared param names — `P`'s keys, without the optional marker.
     * Empty for a param-less value. The optional ones are also in
     * `optionalParams`.
     */
    params: readonly (keyof P & string)[];
    /** Absent ⇒ loaded on first mount (the declaration's `"none"`). */
    preload?: ResourcePreload;
    /** Absent ⇒ pushed (the declaration's `"push"`). See {@link LiveValueLoad}. */
    load?: "on-demand";
  };

/**
 * A declared live value — a `ResourceDescriptor` discriminated from a
 * collection by `live: "value"`.
 */
export type LiveValue<
  T,
  P extends Record<string, string> = Record<string, never>,
  O extends LiveValueOrigin = "worktree",
> = LiveValueBase<T, P, O> & {
  /** A value is pushed whole — never a row-keyed delta (a paged value's pages are: {@link LivePagedPages}). */
  keyed?: never;
};

/**
 * How a value reaches the tab. `"push"` (the default): the server recomputes a
 * changed value and pushes it. `"on-demand"`: the server skips the loader in
 * the shared flush, sends an `invalidate`, and each subscribed tab refetches
 * over HTTP — for a slow loader kept out of the flush cycle.
 */
export type LiveValueLoad = "push" | "on-demand";

/** A param-less value: may be preloaded. */
export interface LiveValueSpec<T> {
  /** A typed-query value — see {@link LiveQueryValueSpec}. */
  query?: undefined;
  /** A paged value — see {@link LivePagedValueSpec}. */
  paged?: undefined;
  /** The payload's wire schema — every push and HTTP read parses through it. */
  schema: ZodParser<T>;
  params?: undefined;
  /** Default `"none"` (see {@link LivePreload}). */
  preload?: LivePreload;
  /** Default `"push"` (see {@link LiveValueLoad}). */
  load?: LiveValueLoad;
  /** A worktree value (the default) — see {@link LiveCentralValueSpec}. */
  origin?: undefined;
}

/**
 * A value served by the central runtime (`serveValue` from
 * `network/live/central`). Never preloaded: the boot snapshot is a worktree
 * backend's read, and it cannot load a central key.
 */
export interface LiveCentralValueSpec<T> {
  /** A typed-query value — see {@link LiveQueryValueSpec}. */
  query?: undefined;
  /** A paged value — see {@link LivePagedValueSpec}. */
  paged?: undefined;
  schema: ZodParser<T>;
  params?: undefined;
  preload?: never;
  /** Default `"push"` (see {@link LiveValueLoad}). */
  load?: LiveValueLoad;
  origin: "central";
}

/**
 * A parameterized value, not preloaded (see {@link LivePreloadedParamValueSpec}
 * for one that is).
 */
export interface LiveParamValueSpec<T, N extends readonly string[]> {
  /** A typed-query value — see {@link LiveQueryValueSpec}. */
  query?: undefined;
  /** A paged value — see {@link LivePagedValueSpec}. */
  paged?: undefined;
  schema: ZodParser<T>;
  /**
   * The param names — a const tuple; derives `P` (each name → a string; a name
   * ending in `?` → an optional one, see {@link LiveValueParams}).
   */
  params: N;
  preload?: never;
  /** Default `"push"` (see {@link LiveValueLoad}). */
  load?: LiveValueLoad;
  /** `"central"`: served by the central runtime (see {@link LiveValueOrigin}). */
  origin?: "central";
}

/**
 * A parameterized value preloaded at boot. It has no default tuple, so the
 * SERVER names the tuples to hydrate: its `serveValue` must pass
 * `preloadParams` (a tsc error otherwise — the returned value's `preload` is
 * required, which is what `serveValue` keys the requirement on). The boot
 * snapshot loads each enumerated tuple and the client hydrates it before first
 * paint; `"boot-and-keep"` keeps every tuple of the key resident. Never
 * L2-persisted (L2 rows are one param-less tuple per key). A worktree value only.
 */
export interface LivePreloadedParamValueSpec<T, N extends readonly string[]> {
  /** A typed-query value — see {@link LiveQueryValueSpec}. */
  query?: undefined;
  /** A paged value — see {@link LivePagedValueSpec}. */
  paged?: undefined;
  schema: ZodParser<T>;
  /** As on {@link LiveParamValueSpec}. */
  params: N;
  preload: ResourcePreload;
  /** Default `"push"` (see {@link LiveValueLoad}). */
  load?: LiveValueLoad;
  origin?: undefined;
}

/**
 * A value with TYPED params (see {@link LiveValueParamParsers}), not preloaded:
 * `P` is each parser's output, so `useLive` and the loader see the narrowed
 * type (`{ window: "1h" | "24h" | "7d" }`), and the runtime gate parses every
 * arriving tuple through the parsers.
 */
export interface LiveTypedParamValueSpec<T, R extends LiveValueParamParsers> {
  /** A typed-query value — see {@link LiveQueryValueSpec}. */
  query?: undefined;
  /** A paged value — see {@link LivePagedValueSpec}. */
  paged?: undefined;
  schema: ZodParser<T>;
  /** The param parsers — every name required. */
  params: R;
  preload?: never;
  /** Default `"push"` (see {@link LiveValueLoad}). */
  load?: LiveValueLoad;
  /** `"central"`: served by the central runtime (see {@link LiveValueOrigin}). */
  origin?: "central";
}

/**
 * A PARAMETERIZED preloaded value (`liveValue` with `params` and `preload`). It
 * has no default tuple, so `preloadsParams` brands it: its `serveValue` must
 * enumerate the tuples to hydrate (`preloadParams` — a tsc error without it,
 * and a throw at serve time for an untyped caller). The brand is a real field,
 * read by that throw.
 */
export type LivePreloadedParamValue<
  T,
  P extends Record<string, string>,
> = LiveValue<T, P> & { preload: ResourcePreload; preloadsParams: true };

/**
 * A value whose question is STRUCTURED: the read passes a typed query (any
 * JSON-safe zod schema's input), the loader receives the schema's output, and
 * the wire carries it as one canonical string param, `q` (see
 * `./query-value.ts`). Mutually exclusive with `params`; never preloaded (it
 * has no default tuple). A central one is allowed, as for `params`.
 */
export interface LiveQueryValueSpec<T, Q, QIn, O extends LiveValueOrigin> {
  schema: ZodParser<T>;
  /** The question's schema — its input is what `useLive` takes, its output what the loader gets. */
  query: LiveQuerySchema<Q, QIn>;
  params?: never;
  preload?: never;
  paged?: undefined;
  /** Default `"push"` (see {@link LiveValueLoad}). */
  load?: LiveValueLoad;
  /** `"central"`: served by the central runtime (see {@link LiveValueOrigin}). */
  origin?: O;
}

/** An item field holding a string — what a paged value identifies its items by. */
type StringKeyOf<Item> = {
  [K in keyof Item]-?: Item[K] extends string ? K : never;
}[keyof Item] &
  string;

/** A direction of one order-key part. */
export type LiveKeyDirection = "asc" | "desc";

/**
 * How a paged value's items are ordered: `of(item)` reads the item's order
 * key — one exact TEXT part per `order` entry (or `null`), whose text order
 * is the order (the source supplies the precision, as Postgres `::text` does:
 * an instant at a fixed precision, a zero-padded number) — and the framework
 * appends the item's id as the tiebreak (ascending). A `null` part sorts last
 * in either direction. See `shared/key-order.ts`.
 */
export interface LivePagedKey<Item> {
  // A method, so a value of any item type is a `LivePagedValue<unknown, …>`.
  of(item: Item): LiveCutKey;
  order: readonly LiveKeyDirection[];
}

/**
 * How a paged value pages: each page is a key range of `item`s, identified by
 * `id` and ordered by `key`; page 0 — and each step a read grows by — is
 * `limit` items, and no page is ever over `maxLimit` (≥ 2 · `limit`). `meta`
 * (optional) is a per-QUESTION fact (a total), served as the sibling value
 * `value.meta` — never a page's, since page 0 may be split or released.
 */
export interface LivePagedSpec<Item, Meta> {
  /** The item's wire schema — a zod object (its `$key` field is the framework's). */
  item: LiveRowSchema<Item>;
  /** The item field that identifies it — unique within a question's items, and the key's tiebreak. */
  id: StringKeyOf<Item>;
  key: LivePagedKey<Item>;
  /** H: page 0's limit, and the step a read grows by. */
  limit: number;
  /** The largest page a tuple may ask — at least 2 · `limit` (a page that splits is read at twice the step). */
  maxLimit: number;
  /** The per-question sibling's schema — see {@link LivePagedValue.meta}. */
  meta?: ZodParser<Meta>;
}

/**
 * A KEY-RANGE-PAGED external value: one page per tuple `{ q, limit, after?,
 * until? }` (the question, the page's limit and its cuts — server-minted row
 * keys), its payload the page's items, each carrying its `$key`. Read through
 * `useLive` like a scroll collection's window: with a viewport, the pages near
 * it live and no depth limit; without one, every page live, capped at
 * `maxLimit` items. No `schema` (it is derived), no `params`, no preload;
 * served `source: "external"` only — a paged Postgres list is a
 * `liveCollection`.
 */
export interface LivePagedValueSpec<
  Item,
  Meta,
  Q,
  QIn,
  O extends LiveValueOrigin,
> {
  schema?: never;
  query: LiveQuerySchema<Q, QIn>;
  paged: LivePagedSpec<Item, Meta>;
  params?: never;
  preload?: never;
  /**
   * None: a page is a keyed window, whose changes ship as keyed deltas (D3)
   * — there is no `invalidate` of one for a tab to refetch over HTTP. The
   * meta sibling is pushed like the pages.
   */
  load?: never;
  /** `"central"`: served by the central runtime (see {@link LiveValueOrigin}). */
  origin?: O;
}

/**
 * Any paged spec, erased — the implementation signatures' view. `any`: an
 * item type's field names (`id: StringKeyOf<Item>`) erase to `never` under
 * `unknown`, which no real spec is assignable to.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above.
type AnyPagedValueSpec = LivePagedValueSpec<
  any,
  any,
  any,
  any,
  LiveValueOrigin
>;

/** A declared typed-query value: a {@link LiveValue} over `{ q }` that carries its codec. */
export type LiveQueryValue<
  T,
  Q,
  QIn = Q,
  O extends LiveValueOrigin = "worktree",
> = LiveValue<T, LiveQueryParams, O> & {
  query: LiveQueryCodec<Q, QIn>;
  paged?: undefined;
};

/**
 * A declared paged value: a {@link LiveValue} per page tuple (its payload the
 * page's items), with its codec, its paging and — declared `paged.meta` — its
 * per-question sibling.
 */
export type LivePagedValue<
  Item,
  Meta,
  Q,
  QIn = Q,
  O extends LiveValueOrigin = "worktree",
> = LivePagedPages<Item, Q, QIn, O> & LivePagedMeta<Meta, Q, QIn, O>;

/**
 * A paged value without its meta sibling — what a read of its pages needs,
 * and the one shape every paged value is (whatever its `Meta`).
 */
export type LivePagedPages<
  Item,
  Q,
  QIn = Q,
  O extends LiveValueOrigin = "worktree",
> = LiveValueBase<Item[], LivePagedParams, O> & {
  /**
   * A page is a KEYED window (D3): each item identified by its `paged.id`,
   * so a change reaches the page as a keyed delta and a page can be seeded
   * from the items other pages of its question hold — exactly a scroll
   * collection's window.
   */
  keyed: { keyOf: (row: unknown) => string };
  /** Always pushed: a keyed page ships deltas, never an `invalidate`. */
  load?: never;
  query: LivePagedCodec<Q, QIn>;
  paged: {
    /** The item field a page's items are identified by. */
    id: string;
    key: LivePagedKey<Item>;
    /** H: page 0's limit and a read's step. */
    limit: number;
    /** The largest page a tuple may ask. */
    maxLimit: number;
  };
};

/**
 * The per-question sibling (`<key>:meta`, a typed-query value over the same
 * question — `useLive(v.meta, query)`), refreshed by the same `notify(q)`;
 * absent when the declaration has no `paged.meta`.
 */
type LivePagedMeta<Meta, Q, QIn, O extends LiveValueOrigin> = [Meta] extends [
  undefined,
]
  ? { meta?: undefined }
  : { meta: LiveQueryValue<Meta, Q, QIn, O> };

/**
 * A value read by a params tuple — neither a typed-query nor a paged one. The
 * overloads that take `P` take this, so a query value's `{ q }` wire tuple
 * cannot be passed for its query.
 */
export type LivePlainValue<
  T,
  P extends Record<string, string>,
  O extends LiveValueOrigin = "worktree",
> = LiveValue<T, P, O> & { query?: undefined };

/**
 * Declare a live value.
 *
 * ```ts
 * export const notificationsUnread = liveValue("notifications.unread", {
 *   schema: NotificationsUnreadSchema,
 *   preload: "boot",                 // "none" (default) | "boot" | "boot-and-keep"
 * });
 * export const pluginChanges = liveValue("review.plugin-changes", {
 *   schema: PluginChangesSchema,
 *   params: ["conversationId"],      // → P = { conversationId: string }
 * });
 * export const configValues = liveValue("config-v2.values", {
 *   schema: ConfigValuesSchema,
 *   params: ["path", "scopeId?"],    // → P = { path: string; scopeId?: string }
 *   preload: "boot-and-keep",        // the served half enumerates the tuples
 * });
 * export const latencySummary = liveValue("latency-ledger.summary", {
 *   schema: LatencySummarySchema,
 *   params: { window: z.enum(LATENCY_WINDOWS) }, // → P = { window: "1h" | … }
 * });
 * ```
 *
 * `key` stays a positional string literal: the build scanners read it
 * statically. A preloaded value also sets `defaultParams: {}`, so the boot
 * snapshot's fallback load and the client's hydrate land on the same tuple
 * `useLive(value)` subscribes to.
 *
 * `origin: "central"` declares a value the central runtime serves (the
 * browser subscribes over the central socket); its `LiveValue` carries the
 * origin in its type, so only `network/live/central`'s `serveValue` takes it.
 *
 * A STRUCTURED question is `query` (a typed-query value), and a key-range-paged
 * external read is `query` + `paged` — see {@link LiveQueryValueSpec} and
 * {@link LivePagedValueSpec}:
 *
 * ```ts
 * export const metricQuery = liveValue("metrics.query", {
 *   schema: MetricResultSchema,
 *   query: MetricQuerySchema,        // → useLive(metricQuery, query)
 *   load: "on-demand",
 * });
 * export const metricDetails = liveValue("metrics.details", {
 *   query: DetailsSelectorSchema,
 *   paged: {
 *     item: DrillItemSchema,
 *     id: "id",
 *     key: { of: (i) => [i.at], order: ["desc"] },
 *     limit: 50,
 *     maxLimit: 500,
 *     meta: TotalSchema,                // → metricDetails.meta
 *   },
 * });
 * ```
 */
export function liveValue<
  Item,
  Meta,
  Q,
  QIn,
  O extends LiveValueOrigin = "worktree",
>(
  key: string,
  spec: LivePagedValueSpec<Item, Meta, Q, QIn, O> & {
    paged: { meta: ZodParser<Meta> };
  },
): LivePagedValue<Item, Meta, Q, QIn, O>;
export function liveValue<Item, Q, QIn, O extends LiveValueOrigin = "worktree">(
  key: string,
  spec: LivePagedValueSpec<Item, undefined, Q, QIn, O> & {
    paged: { meta?: undefined };
  },
): LivePagedValue<Item, undefined, Q, QIn, O>;
export function liveValue<T, Q, QIn, O extends LiveValueOrigin = "worktree">(
  key: string,
  spec: LiveQueryValueSpec<T, Q, QIn, O>,
): LiveQueryValue<T, Q, QIn, O>;
export function liveValue<T>(
  key: string,
  spec: LiveCentralValueSpec<T>,
): LiveValue<T, Record<string, never>, "central">;
export function liveValue<T>(
  key: string,
  spec: LiveValueSpec<T>,
): LiveValue<T, Record<string, never>>;
export function liveValue<T, const N extends readonly [string, ...string[]]>(
  key: string,
  spec: LivePreloadedParamValueSpec<T, N>,
): LivePreloadedParamValue<T, LiveValueParams<N>>;
export function liveValue<T, const N extends readonly [string, ...string[]]>(
  key: string,
  spec: LiveParamValueSpec<T, N> & { origin: "central" },
): LiveValue<T, LiveValueParams<N>, "central">;
export function liveValue<T, const N extends readonly [string, ...string[]]>(
  key: string,
  spec: LiveParamValueSpec<T, N> & { origin?: undefined },
): LiveValue<T, LiveValueParams<N>>;
export function liveValue<T, const R extends LiveValueParamParsers>(
  key: string,
  spec: LiveTypedParamValueSpec<T, R> & {
    origin: "central";
  } & LiteralParamNames<R>,
): LiveValue<T, LiveTypedValueParams<R>, "central">;
export function liveValue<T, const R extends LiveValueParamParsers>(
  key: string,
  spec: LiveTypedParamValueSpec<T, R> & {
    origin?: undefined;
  } & LiteralParamNames<R>,
): LiveValue<T, LiveTypedValueParams<R>>;
export function liveValue<T>(
  key: string,
  spec:
    | LiveValueSpec<T>
    | LiveCentralValueSpec<T>
    | LiveParamValueSpec<T, readonly string[]>
    | LivePreloadedParamValueSpec<T, readonly string[]>
    | LiveTypedParamValueSpec<T, LiveValueParamParsers>
    | LiveQueryValueSpec<T, unknown, unknown, LiveValueOrigin>
    | AnyPagedValueSpec,
): DeclaredValue<T> {
  if (spec.query !== undefined) return queryValue(key, spec);
  // A name list (`["id", "scopeId?"]`) or a typed record of parsers.
  const declared = spec.params ?? [];
  const { params, optionalParams, parsers } = isParamNameList(declared)
    ? { ...parseParamNames(key, declared), parsers: undefined }
    : {
        params: Object.keys(checkParamParsers(key, declared)),
        optionalParams: [],
        parsers: declared,
      };
  const preload =
    spec.preload === undefined || spec.preload === "none"
      ? undefined
      : spec.preload;
  if (preload !== undefined && spec.origin === "central") {
    // Unreachable from typed code (`preload` is `never` on a central value).
    throw new Error(
      `liveValue("${key}"): a central value cannot be preloaded — the boot ` +
        `snapshot is a worktree backend's read.`,
    );
  }
  const value: LiveValue<T, Record<string, string>, LiveValueOrigin> = {
    key,
    schema: spec.schema,
    live: "value",
    params,
    ...(optionalParams.length > 0 ? { optionalParams } : {}),
    validateParams: paramsGate(key, params, optionalParams, parsers),
    ...(spec.origin === "central" ? { origin: "central" as const } : {}),
    // A param-less preload has ONE tuple, `{}` — the one `useLive(value)`
    // reads. A param'd one has none: its server half enumerates them.
    ...(preload !== undefined
      ? {
          preload,
          ...(params.length === 0
            ? { defaultParams: {} }
            : { preloadsParams: true as const }),
        }
      : {}),
    ...(spec.load === "on-demand" ? { load: "on-demand" as const } : {}),
  };
  registerResourceDescriptor(value as ResourceDescriptor<unknown>);
  return value;
}

/** What `liveValue`'s implementation declares, erased: a value, or a paged one's (keyed) pages. */
type DeclaredValue<T> =
  | LiveValue<T, Record<string, string>, LiveValueOrigin>
  | LivePagedPages<unknown, unknown, unknown, LiveValueOrigin>;

/**
 * The typed-query and paged forms: `params` derived from the codec (`["q"]`,
 * or `["q", "limit", "after", "until"]` with the cuts optional), the gate the
 * codec's strict decode, and — for a paged value — the derived page schema
 * and the meta sibling.
 */
function queryValue<T>(
  key: string,
  spec:
    | LiveQueryValueSpec<T, unknown, unknown, LiveValueOrigin>
    | AnyPagedValueSpec,
): DeclaredValue<T> {
  // Unreachable from typed code (each is `never` beside `query`).
  const stray = (["params", "preload"] as const).filter(
    (f) => (spec as unknown as Record<string, unknown>)[f] !== undefined,
  );
  if (stray.length > 0) {
    throw new Error(
      `liveValue("${key}"): \`${stray.join("`, `")}\` cannot be declared ` +
        `beside \`query\` — a query value's tuple is its question, and it ` +
        `has no default tuple to preload.`,
    );
  }
  const common = {
    key,
    live: "value" as const,
    ...(spec.origin === "central" ? { origin: "central" as const } : {}),
    ...(spec.load === "on-demand" ? { load: "on-demand" as const } : {}),
  };
  let value: DeclaredValue<T>;
  if (spec.paged === undefined) {
    const s = spec as LiveQueryValueSpec<T, unknown, unknown, LiveValueOrigin>;
    const query = liveQueryCodec(key, s.query);
    value = {
      ...common,
      schema: s.schema,
      params: ["q"],
      validateParams: (params: Record<string, string>) =>
        void query.decode(params),
      query,
    } as LiveValue<T, Record<string, string>, LiveValueOrigin>;
  } else {
    value = pagedValue(key, spec as AnyPagedValueSpec, common);
  }
  registerResourceDescriptor(value as ResourceDescriptor<unknown>);
  return value;
}

/** A paged value's declaration, checked: its codec, its derived page schema and its meta sibling. */
function pagedValue(
  key: string,
  s: AnyPagedValueSpec,
  common: {
    key: string;
    live: "value";
    origin?: "central";
    load?: "on-demand";
  },
): LivePagedValue<unknown, unknown, unknown, unknown, LiveValueOrigin> {
  if ((s as { schema?: unknown }).schema !== undefined) {
    throw new Error(
      `liveValue("${key}"): a paged value derives its schema from \`paged\` — ` +
        `declare \`paged.item\` (and \`paged.meta\`), not \`schema\`.`,
    );
  }
  if (common.load !== undefined) {
    // Unreachable from typed code (`load` is `never` beside `paged`).
    throw new Error(
      `liveValue("${key}"): a paged value takes no \`load\` — its pages are ` +
        `keyed windows, pushed as deltas.`,
    );
  }
  const { item, id, key: order, meta, limit, maxLimit } = s.paged;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `liveValue("${key}"): paged.limit ${limit} is not a positive integer.`,
    );
  }
  if (!Number.isInteger(maxLimit) || maxLimit < 2 * limit) {
    throw new Error(
      `liveValue("${key}"): paged.maxLimit needs to be an integer ≥ 2 · paged.limit ` +
        `(${2 * limit}), got ${maxLimit} — a page that splits is read at ` +
        `2 · limit, a step of headroom over the items it holds.`,
    );
  }
  if (
    typeof order?.of !== "function" ||
    !Array.isArray(order.order) ||
    !order.order.every((d) => d === "asc" || d === "desc")
  ) {
    throw new Error(
      `liveValue("${key}"): paged.key needs \`of\` (an item's order-key parts) ` +
        `and \`order\` (one "asc" | "desc" per part).`,
    );
  }
  if (Object.hasOwn(item.shape, LIVE_ROW_KEY)) {
    throw new Error(
      `liveValue("${key}"): "${LIVE_ROW_KEY}" is reserved — the framework mints each item's row key under it`,
    );
  }
  const query = livePagedCodec(key, s.query, {
    // The order's parts, then the id.
    arity: order.order.length + 1,
    maxLimit,
  });
  // A page's items carry the server-minted `$key` beside the item fields:
  // declared on the wire schema (so the runtime's parse keeps it), and split
  // off by every read before items reach a consumer.
  const row = z.intersection(
    item as unknown as z.ZodTypeAny,
    z.object({ [LIVE_ROW_KEY]: z.string().nullable() }),
  );
  return {
    ...common,
    schema: z.array(row),
    keyed: {
      keyOf: (r: unknown) => (r as Record<string, unknown>)[id] as string,
    },
    params: ["q", "limit", "after", "until"],
    optionalParams: ["after", "until"],
    validateParams: (params: Record<string, string>) =>
      void query.decode(params),
    query,
    paged: { id, key: order, limit, maxLimit },
    meta:
      meta === undefined
        ? undefined
        : queryValue(`${key}:meta`, {
            schema: meta,
            query: s.query,
            ...(common.origin !== undefined ? { origin: common.origin } : {}),
          }),
  } as unknown as LivePagedValue<
    unknown,
    unknown,
    unknown,
    unknown,
    LiveValueOrigin
  >;
}

function isParamNameList(
  params: readonly string[] | LiveValueParamParsers,
): params is readonly string[] {
  return Array.isArray(params);
}

/**
 * The zod type names a typed param's parser may not contain anywhere: each one
 * either CHANGES the value (a transform / preprocess — `ZodEffects`, which also
 * carries `.refine`, refused with it rather than told apart by a private
 * `effect.type`) or invents one where the wire had none (`ZodDefault`,
 * `ZodCatch`). Any of them would hand the loader something other than the
 * wire string its tuple is keyed by.
 */
const REFUSED_PARSER_KINDS: ReadonlySet<string> = new Set([
  "ZodEffects",
  "ZodDefault",
  "ZodCatch",
]);

/**
 * The `ZodString` checks that REWRITE the value in place rather than test it:
 * zod implements `.trim()` / `.toLowerCase()` / `.toUpperCase()` as entries in
 * `_def.checks`, not as a `ZodEffects`, so the type-name walk alone would let
 * them through — and `" a"` would reach the loader as `"a"`.
 */
const REFUSED_STRING_CHECKS: ReadonlySet<string> = new Set([
  "trim",
  "toLowerCase",
  "toUpperCase",
]);

/**
 * Validate a typed params declaration at declaration time (what tsc cannot
 * see): a non-empty record of non-empty names, none of whose parsers contains a
 * refused kind (walked through every nested schema in its `_def`), and none of
 * which accepts `undefined` — every typed param is required, so a parser that
 * passes an absent value is a declaration of an optional param in disguise.
 */
function checkParamParsers(
  key: string,
  parsers: LiveValueParamParsers,
): LiveValueParamParsers {
  // Returns `parsers` itself, so the call reads as the checked record.
  const names = Object.keys(parsers);
  if (names.length === 0) {
    throw new Error(
      `liveValue("${key}"): an empty params record — omit \`params\` for a ` +
        `param-less value.`,
    );
  }
  for (const [name, parser] of Object.entries(parsers)) {
    if (name === "" || name.includes("?")) {
      throw new Error(
        `liveValue("${key}"): bad param name "${name}" — a typed param is a ` +
          `non-empty name, always required (no "?").`,
      );
    }
    const refused = findRefusedKind(parser, new Set());
    if (refused !== undefined) {
      throw new Error(
        `liveValue("${key}"): param "${name}" is parsed by a ${refused} — a ` +
          `typed param's parser may only narrow the wire string, never ` +
          `transform, default or catch it (the loader receives the wire ` +
          `string itself).`,
      );
    }
    if (parser.safeParse(undefined).success) {
      throw new Error(
        `liveValue("${key}"): param "${name}"'s parser accepts undefined — ` +
          `every typed param is required.`,
      );
    }
  }
  return parsers;
}

/** A schema's zod type name (`_def.typeName`), or undefined for a non-schema. */
function zodTypeName(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null || !("_def" in node)) {
    return undefined;
  }
  const def: unknown = node._def;
  if (typeof def !== "object" || def === null || !("typeName" in def)) {
    return undefined;
  }
  return typeof def.typeName === "string" ? def.typeName : undefined;
}

/**
 * The first refused zod kind anywhere in `schema`: the schema itself, then
 * every schema (or array of schemas) held in its `_def` — `innerType`,
 * `schema`, `in` / `out`, `options`, `type`, … — so a refused kind cannot hide
 * under `.optional()`, `.pipe()`, `.brand()` or a union. A `ZodLazy` getter is
 * not followed (it is never a string parser's shape).
 */
function findRefusedKind(
  schema: unknown,
  seen: Set<unknown>,
): string | undefined {
  const typeName = zodTypeName(schema);
  if (typeName === undefined || seen.has(schema)) return undefined;
  seen.add(schema);
  if (REFUSED_PARSER_KINDS.has(typeName)) return typeName;
  const def = (schema as { _def: Record<string, unknown> })._def;
  if (typeName === "ZodString" && Array.isArray(def.checks)) {
    for (const check of def.checks as readonly unknown[]) {
      const kind =
        typeof check === "object" && check !== null && "kind" in check
          ? check.kind
          : undefined;
      if (typeof kind === "string" && REFUSED_STRING_CHECKS.has(kind)) {
        return `ZodString .${kind}()`;
      }
    }
  }
  for (const child of Object.values(def)) {
    const children: readonly unknown[] = Array.isArray(child) ? child : [child];
    for (const c of children) {
      const found = findRefusedKind(c, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Split declared param names into the bare names and the optional ones (a
 * trailing `?`). Throws on a name tsc cannot reject: empty, a `?` anywhere but
 * the end, or a duplicate.
 */
function parseParamNames(
  key: string,
  declared: readonly string[],
): { params: string[]; optionalParams: string[] } {
  const params: string[] = [];
  const optionalParams: string[] = [];
  for (const raw of declared) {
    const optional = raw.endsWith("?");
    const name = optional ? raw.slice(0, -1) : raw;
    if (name === "" || name.includes("?") || params.includes(name)) {
      throw new Error(
        `liveValue("${key}"): bad param name "${raw}" — each is a non-empty, ` +
          `unique name, optionally ending in one "?".`,
      );
    }
    params.push(name);
    if (optional) optionalParams.push(name);
  }
  return { params, optionalParams };
}

/**
 * A value's params gate: the tuple names ONLY declared params, each a string,
 * and every REQUIRED one. An optional param (`"scopeId?"`) may be absent — the
 * runtime has already folded its `undefined` / `""` spellings away
 * (`canonicalParams`) before the gate runs. Without the gate a loader reads
 * `undefined` for a required param an older (or newer) bundle does not send,
 * and fails somewhere far from the cause.
 *
 * A typed declaration also parses each present param through its parser: a
 * refusal is a `ResourceContractError` (a bundle sending a value the
 * declaration does not admit). The gate stays `void` — the loader receives the
 * wire tuple — so a parser whose output is not the wire string itself is a
 * broken declaration the declaration-time walk missed: a plain Error, the
 * backstop.
 */
function paramsGate(
  key: string,
  declared: readonly string[],
  optional: readonly string[],
  parsers: LiveValueParamParsers | undefined,
): (params: Record<string, string>) => void {
  const names = new Set(declared);
  const required = declared.filter((name) => !optional.includes(name));
  return (params) => {
    const reject = (detail: string): never => {
      throw new ResourceContractError(key, `liveValue("${key}"): ${detail}`);
    };
    for (const [name, v] of Object.entries(params)) {
      if (!names.has(name)) reject(`unknown param "${name}"`);
      if (typeof v !== "string") {
        reject(`param "${name}" must be a string, got ${JSON.stringify(v)}`);
      }
      const parser = parsers?.[name];
      if (parser === undefined) continue;
      const parsed = parser.safeParse(v);
      if (!parsed.success) {
        reject(
          `param "${name}" = ${JSON.stringify(v)} is refused by its parser: ` +
            parsed.error.issues.map((i) => i.message).join("; "),
        );
      } else if (parsed.data !== v) {
        throw new Error(
          `liveValue("${key}"): param "${name}"'s parser turned ` +
            `${JSON.stringify(v)} into ${JSON.stringify(parsed.data)} — a ` +
            `typed param's parser must return the wire string unchanged.`,
        );
      }
    }
    for (const name of required) {
      if (!Object.hasOwn(params, name)) reject(`missing param "${name}"`);
    }
  };
}
