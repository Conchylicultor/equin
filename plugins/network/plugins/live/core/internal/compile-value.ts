import type {
  DependsOnEntry,
  ExternalResource,
  ExternalWindowPolicy,
  KeyedResourceContract,
  KeyedServerResourceOptions,
  Resource,
  ResourceContract,
  ResourceRuntime,
  ServerResourceOptions,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  LIVE_ROW_KEY,
  LIVE_ROW_KEY_MAX_BYTES,
  type LiveCutKey,
} from "./row-key";
import type {
  LiveKeyDirection,
  LivePagedKey,
  LivePagedValue,
  LivePlainValue,
  LiveQueryValue,
  LiveSnapshotBrand,
  LiveValue,
  LiveValueOrigin,
} from "./live-value";
import type {
  LiveKeyRange,
  LivePagedParams,
  LiveQueryParams,
} from "./query-value";
import { compareKeyParts, cutParts } from "./key-order";

// The option compilation behind BOTH `serveValue`s — the worktree one
// (`network/live/server`, on server-core's runtime) and the central one
// (`network/live/central`, on central-core's). It lives here, once, so the two
// barrels cannot drift: each only injects its runtime's two register
// primitives and shapes the served object its plugin definition takes.
//
// A served value declares WHERE its truth lives (`source`) and how to read it
// (`loader`), never a delivery mode: that is the `liveValue` declaration's
// `load`, which the client reads too.
// Everything else is one named option, each folded into the runtime's own
// two-arg `defineResource` / `defineExternalResource`:
//
// - `throttleMs`        → the runtime's `debounceMs` (a fixed trailing window,
//                         not re-armed — a throttle, whatever the old name said).
// - `recomputeOn`       → `dependsOn` edges, from EXTERNAL upstreams only (T15:
//                         a db upstream's writes reach this value's read-set
//                         through the change feed already, so a cascade would
//                         serve it twice). A bare served value recomputes
//                         every currently-subscribed tuple of THIS value (the
//                         runtime's `toSubscribed` edge; a param-less value
//                         always recomputes its one `{}` tuple). The mapped form
//                         `{ value, params }` is a plain per-tuple edge.
// - `whileSubscribed`   → the runtime's `onFirstSubscribe` / `onLastUnsubscribe`
//                         pair, owned here so a start without a stop cannot be
//                         written (see `pairLifecycle`).
// - `revalidate`        → passed through.
//
// A typed-query value (`liveValue(key, { query })`) and a paged one
// (`{ query, paged }`) are served by the same options, over their DECODED
// question: the loader, `whileSubscribed`, a mapped `recomputeOn` and
// `notify` take the question `Q` (the paged loader adds the key range asked,
// `LiveKeyRange`), and this file decodes each wire tuple through the
// declaration's own codec — the one the params gate and the browser's read use.
//
// A paged value is TWO resources — its pages and, declared `paged.meta`, its
// per-question `:meta` sibling — compiled together (`compilePagedValue`): one
// `whileSubscribed` per QUESTION (refcounted over every page tuple and the
// meta tuple of it, so a read that splits its pages never restarts a
// watcher), one `notify(q)` reaching all of them, and every page's answer
// checked against its range and minted its `$key` here. A page is a KEYED
// external window (the runtime's `ExternalWindowPolicy`, D3): `notify(q)`
// re-reads each live page of `q` and ships its keyed diff, and a page may be
// seeded from the pages of its question the server holds — its size and
// family read off the page codec.

/** Where a value's truth lives: Postgres (change feed) or anything else (`notify`). */
export type LiveValueSource = "db" | "external";

/**
 * How an EXTERNAL value's answer changes — required on the external arm (a db
 * value's freshness is the change feed's), so a value that is never told of a
 * change cannot be written without saying why that is honest:
 *
 * - `"notified"` — something calls `served.notify(...)`, or `whileSubscribed`
 *   (or a `recomputeOn` upstream) does. The only arm with `notify`,
 *   `whileSubscribed`, `recomputeOn` and `throttleMs`.
 * - `{ immutable: { reason } }` — a tuple's answer can never change (sha-keyed,
 *   a terminal run's artifact).
 * - `{ fixed: { reason } }` — constant for the process lifetime (a
 *   contribution registry, a catalog read once, a third-party answer with no
 *   change signal).
 * - `{ snapshot: { reason } }` — re-measured only when a reader asks: the
 *   value is declared `load: "snapshot"` (tsc pairs the two), every HTTP read
 *   runs the loader (no `revalidate`), and the read's `refresh()` is the
 *   Refresh button.
 */
export type LiveValueChanges =
  | "notified"
  | { immutable: { reason: string } }
  | { fixed: { reason: string } }
  | { snapshot: { reason: string } };

/** A `changes` naming no change signal: the served value has no `notify`. */
export type LiveUnnotifiedChanges = Exclude<LiveValueChanges, "notified">;

/** True (as a type) when `C` is the snapshot arm. */
type IsSnapshot<C> = [C] extends [{ snapshot: unknown }] ? true : false;

/**
 * The declaration a `changes` takes: a snapshot value for `{ snapshot }`, any
 * other for every other arm (see `LiveSnapshotBrand`). The db arm takes the
 * non-snapshot one (`SnapshotPairing<"notified">`).
 */
export type SnapshotPairing<C> = LiveSnapshotBrand<
  IsSnapshot<C> extends true ? "snapshot" : "push"
>;

/**
 * The declaration a `source` takes: a db value never a bytes one (a Postgres
 * row is not a binary payload, and the change feed's recompute is a push) —
 * a bytes value's `bytes: true` is not assignable to `bytes?: undefined`; an
 * external value takes either.
 */
export type BytesPairing<Src extends LiveValueSource> = Src extends "db"
  ? { bytes?: undefined }
  : unknown;

/** Stops what a `whileSubscribed` start began. */
export type StopFn = () => void;

/**
 * Any served value, whichever runtime serves it — the runtime `Resource` plus
 * what `serveValue` records about it. An upstream in `recomputeOn` is one.
 */
export type ServedValueBase<T, P extends Record<string, string>> = Resource<
  T,
  P
> & {
  source: LiveValueSource;
  /** The external arm's declared freshness (see {@link LiveValueChanges}); absent on a db value. */
  changes?: LiveValueChanges;
  /** The collection-shaped value's recorded reason (db arm only). */
  unbounded?: { reason: string };
  /** `[key]` — symmetric with `ServedCollection.keys`. */
  keys: string[];
};

/**
 * What an external `serveValue` returns for `changes: C`: the `Notified` form
 * (with `notify`) for `"notified"`, the `Silent` one (none — nothing may tell
 * an immutable, fixed or snapshot value of a change) for every other arm.
 */
export type ServedFor<C, Notified, Silent> = [C] extends ["notified"]
  ? Notified
  : Silent;

/**
 * A served value that can be a `recomputeOn` upstream: an EXTERNAL one — told
 * apart by its `notify`, which only the external arm has (T15). A db value
 * has none, so naming one in `recomputeOn` is a tsc error. `any`: an upstream
 * of any payload/params — `Resource` is invariant in both. One definition, for
 * the worktree and the central `serveValue` alike.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above.
export type ExternalServed = ServedValueBase<any, any> & {
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  notify(params?: any): void;
};

/** The params type an upstream served value is subscribed with. */
type UpstreamParams<S> = S extends { load(params: infer UP): unknown }
  ? UP
  : never;

/**
 * One `recomputeOn` entry for an upstream `S`: the bare served value
 * (recompute every subscribed tuple of this value), or `{ value, params }`
 * mapping the upstream's changed tuple to the ONE tuple of this value it moves.
 */
export type RecomputeEntry<S, P> =
  S | { value: S; params: (upstreamParams: UpstreamParams<S>) => P };

/**
 * `recomputeOn` typed per element: `R` is inferred from the array, so each
 * mapped entry's `params` sees ITS upstream's params and must return this
 * value's.
 */
export type RecomputeOn<R extends readonly ExternalServed[], P> = {
  [I in keyof R]: RecomputeEntry<R[I], P>;
};

/**
 * True when `T` could grow without bound as a single payload: an array, or a
 * string-indexed record. Distributive, so a union with ANY such arm (`Row[] |
 * null`) counts.
 */
type CollectionShaped<T> = T extends readonly unknown[]
  ? true
  : string extends keyof T
    ? true
    : false;

/**
 * The bound rule, as a type: a Postgres-backed value that is collection-shaped
 * must say why it is not a `liveCollection` (`unbounded: { reason }`), and
 * nothing else may say it. An in-memory (`external`) array is bounded by the
 * process that holds it, so it needs no reason.
 */
type BoundArm<Src extends LiveValueSource, T> = Src extends "db"
  ? true extends CollectionShaped<T>
    ? { unbounded: { reason: string } }
    : { unbounded?: never }
  : { unbounded?: never };

/**
 * The change-signal options of a db value: driven by the change feed alone, so
 * its `whileSubscribed` takes the params only (a second parameter is a tsc
 * error), and it declares no `changes`.
 */
interface DbChangeHooks<S, R extends readonly ExternalServed[]> {
  changes?: never;
  throttleMs?: number;
  recomputeOn?: RecomputeOn<R, S>;
  /**
   * Start something for as long as a tuple has a subscriber (a memo's
   * lifetime); return what stops it. No `notify`: a db value is driven by
   * the change feed alone.
   */
  whileSubscribed?: (params: S) => StopFn | Promise<StopFn>;
}

/** The change-signal options of a `changes: "notified"` external value. */
interface NotifiedHooks<S, R extends readonly ExternalServed[]> {
  throttleMs?: number;
  recomputeOn?: RecomputeOn<R, S>;
  /**
   * Start something for as long as a tuple has a subscriber (a watcher);
   * return what stops it. `notify` recomputes THIS tuple. Runs on the
   * tuple's first subscriber; its stop runs on the last unsubscribe —
   * after the start resolves, if the unsubscribe comes first.
   */
  whileSubscribed?: (params: S, notify: () => void) => StopFn | Promise<StopFn>;
}

/**
 * An immutable / fixed / snapshot value has no change signal, so nothing that
 * reacts to one may be spelled beside it (tsc; a throw for an untyped caller).
 */
interface NoChangeHooks {
  throttleMs?: never;
  recomputeOn?: never;
  whileSubscribed?: never;
}

/**
 * `changes` and the hooks it admits, per arm: a db value declares none; an
 * external one must (`C`, inferred from the call), and only `"notified"`
 * admits `whileSubscribed` / `recomputeOn` / `throttleMs`.
 */
type ChangesArm<
  Src extends LiveValueSource,
  S,
  R extends readonly ExternalServed[],
  C extends LiveValueChanges,
> = Src extends "db"
  ? DbChangeHooks<S, R>
  : {
      /** How this value's answer changes — see {@link LiveValueChanges}. Required. */
      changes: C;
    } & ([C] extends ["notified"] ? NotifiedHooks<S, R> : NoChangeHooks);

/**
 * The options every served value takes, over `S` — the SUBJECT its hooks are
 * handed: the params tuple of a plain value, the decoded question of a
 * typed-query or paged one — `L`, its loader, and `C`, its declared
 * `changes` (external arm).
 */
type ServeOptionsBase<
  T,
  S,
  Src extends LiveValueSource,
  R extends readonly ExternalServed[],
  L,
  C extends LiveValueChanges,
> = {
  /** Where the value's truth lives (see the header). Required. */
  source: Src;
  /** Read the value for one tuple. Parsed against the declaration's schema. */
  loader: L;
} & BoundArm<Src, T> &
  ChangesArm<Src, S, R, C>;

export type ServeValueOptions<
  T,
  P,
  Src extends LiveValueSource,
  R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
> = ServeOptionsBase<T, P, Src, R, (params: P) => Promise<T> | T, C> & {
  /**
   * Conditional-revalidation signature (an ETag): a cheap over-approximation
   * of "did the value change?" the read path compares before running the
   * loader. Read path only. Never on a snapshot: its every read re-measures.
   */
  revalidate?: IsSnapshot<C> extends true
    ? never
    : (params: P) => Promise<string>;
};

/**
 * A paged value's options: external only (a paged Postgres list is a
 * `liveCollection`), its loader asked one key range of a question and
 * answering its items — in the declared key order, inside the range, at most
 * its limit, ids unique (each checked: a violation fails the page loudly).
 * Every hook takes the question `Q`: `whileSubscribed` runs once per question
 * however many of its pages (and its meta) are subscribed, and `notify(query)`
 * reaches every subscribed page of it and its meta. Declared `paged.meta`,
 * `meta(query)` answers the per-question sibling (required — and refused
 * without the declaration).
 */
export type ServePagedValueOptions<
  Item,
  Meta,
  Q,
  R extends readonly ExternalServed[] = [],
  C extends PagedChanges = "notified",
> = ServeOptionsBase<
  Item[],
  Q,
  "external",
  R,
  (query: Q, range: LiveKeyRange) => Promise<readonly Item[]> | readonly Item[],
  C
> & { revalidate?: never } & MetaOption<Meta, Q>;

/** `meta` exactly when the declaration has `paged.meta`. */
type MetaOption<Meta, Q> = [Meta] extends [undefined]
  ? { meta?: never }
  : {
      /** The question's per-question fact (a total), served as `value.meta`. */
      meta: (query: Q) => Promise<Meta> | Meta;
    };

/** A paged value's `changes`: never a snapshot (a paged value is never `load: "snapshot"`). */
export type PagedChanges = Exclude<LiveValueChanges, { snapshot: unknown }>;

/**
 * A value's two-arg runtime options. This compilation never sets `reach`: a
 * value's plan comes from its declared `reads` (required on a db value,
 * optional on a `"notified"` external one), which only the Bun host can
 * compile (query-resource reads drizzle tables) — its `serveValue` adds it at
 * registration. An external value's own `notify` reaches it besides.
 */
type ValueOptions<T, P extends Record<string, string>> = ServerResourceOptions<
  T,
  P
> & { reach?: never };

/** The runtime's two-arg options for a value, plus which factory registers it. */
export interface CompiledValue<T, P extends Record<string, string>, S = P> {
  options: ValueOptions<T, P>;
  external: boolean;
  /** The external arm's declared `changes`; absent on a db value. */
  changes?: LiveValueChanges;
  unbounded?: { reason: string };
  /**
   * The wire tuples a change to `subject` recomputes: the params themselves
   * for a plain value, the one `{ q }` of a typed-query value, every
   * currently-subscribed page of a paged one. What `notify(subject)` and a
   * mapped `recomputeOn` reach.
   */
  tuplesOf(subject: S): P[];
  /**
   * Hand the compiled `whileSubscribed` the registered resource's `notify` (the
   * external arm's second argument). Called once, right after registration; a
   * start that runs before it throws.
   */
  bindNotify(notify: (params: P) => void): void;
}

/**
 * A paged value's pages' runtime options: a keyed external window — no
 * routes (D31), its size and family from the page codec.
 */
export type PagedPageOptions<Item> = KeyedServerResourceOptions<
  Item[],
  LivePagedParams
> &
  ExternalWindowPolicy<LivePagedParams>;

/**
 * The host-facing subset of a `ResourceRuntime` the live API registers on —
 * server-core's runtime, central-core's, or any other host's (a browser
 * server): the two register primitives, each host passing its instance (or
 * its bound functions). Everything `serveValueOn` / `serveCollectionOn`
 * compiles lands through these two.
 */
export type LiveRuntime = Pick<
  ResourceRuntime,
  "defineResource" | "defineExternalResource"
>;

/** A canonical per-tuple key (sorted entries), for the lifecycle pairing. */
export function tupleKey(params: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]]),
  );
}

/** A tuple's start, as the stop side sees it: its stop, or a start that failed. */
type Started = { ok: true; stop: StopFn } | { ok: false };

/**
 * Pair `whileSubscribed` onto the runtime's 0→1 / N→0 hooks. One record per
 * tuple, set synchronously by the start (so an unsubscribe can never find it
 * missing while the start is still resolving) and taken by the stop:
 *
 * - a sync start is stopped directly;
 * - an async start is RETURNED to the runtime (which awaits it before the
 *   first read, and reports a rejection), and a stop arriving first chains
 *   after it — so a watcher is never left running for a tuple nobody holds;
 * - a start that failed has nothing to stop (its error was reported on the
 *   subscribe path).
 *
 * A re-subscribe during a pending stop gets its own record: the old start's
 * stop still runs, independently.
 */
function pairLifecycle<P extends Record<string, string>>(
  whileSubscribed: (params: P) => StopFn | Promise<StopFn>,
): {
  onFirstSubscribe: (params: P) => void | Promise<void>;
  onLastUnsubscribe: (params: P) => void;
} {
  const running = new Map<string, StopFn | Promise<Started>>();
  return {
    onFirstSubscribe(params) {
      const started = whileSubscribed(params);
      if (!(started instanceof Promise)) {
        running.set(tupleKey(params), started);
        return;
      }
      running.set(
        tupleKey(params),
        started.then(
          (stop): Started => ({ ok: true, stop }),
          // The runtime reports this rejection (the promise below is its own).
          (): Started => ({ ok: false }),
        ),
      );
      return started.then(() => undefined);
    },
    onLastUnsubscribe(params) {
      const key = tupleKey(params);
      const record = running.get(key);
      running.delete(key);
      if (record === undefined) return;
      if (!(record instanceof Promise)) {
        record();
        return;
      }
      void record.then((started) => {
        if (started.ok) started.stop();
      });
    },
  };
}

/**
 * How a value's wire tuples map to the subject its hooks are handed, per
 * declaration form: a plain value's subject IS its params; a typed-query
 * value's is the decoded question (one tuple per question). (A paged value's
 * are tracked by `compilePagedValue`: one question has many page tuples.)
 */
interface Subjects<P extends Record<string, string>, S> {
  of(params: P): S;
  tuplesOf(subject: S): P[];
}

function subjectsOf<P extends Record<string, string>, S>(
  value: LiveValue<unknown, P, LiveValueOrigin>,
): Subjects<P, S> {
  const decl = value as unknown as
    | { query?: undefined }
    | LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin>;
  if (decl.query === undefined) {
    return {
      of: (params) => params as unknown as S,
      tuplesOf: (s) => [s as unknown as P],
    };
  }
  const codec = decl.query;
  return {
    of: (params) => codec.decode(params) as S,
    tuplesOf: (s) => [codec.encode(s) as unknown as P],
  };
}

/**
 * The runtime loader for a plain or typed-query value: a plain loader is
 * handed the params, a typed-query one the decoded question.
 */
function loaderOf<T, P extends Record<string, string>>(
  value: LiveValue<T, P, LiveValueOrigin>,
  loader: (...args: never[]) => unknown,
): (params: P) => Promise<T> | T {
  const decl = value as unknown as
    | { query?: undefined }
    | LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin>;
  const call = loader as unknown as (...args: unknown[]) => Promise<T> | T;
  if (decl.query === undefined) return (params) => call(params);
  const codec = decl.query;
  return (params) => call(codec.decode(params));
}

/** An item of a page as the wire carries it: its fields and its `$key`. */
export type PagedRow = Record<string, unknown> & {
  [LIVE_ROW_KEY]: string | null;
};

const encoder = new TextEncoder();

/**
 * One page's answer, checked against the range it was asked and minted its
 * row keys: every item's key is `paged.key.order.length` parts, each text or
 * NULL (`key.of`), then its id (a string); the items are in strictly
 * ascending key order (so no id twice), all inside `(after, until]`, at most
 * `limit`. A violation is the loader's bug — a plain Error, failing the page
 * loudly rather than a reader that pages wrong. Each item is handed out with
 * `$key` — the canonical JSON of its key, `null` past
 * `LIVE_ROW_KEY_MAX_BYTES` (no page can be cut there).
 */
export function pageRowsOf(
  value: { key: string; paged: { id: string; key: LivePagedKey<unknown> } },
  range: LiveKeyRange,
  items: readonly unknown[],
): PagedRow[] {
  const { id, key } = value.paged;
  const fail = (detail: string): never => {
    throw new Error(`serveValue("${value.key}"): ${detail}`);
  };
  if (!Array.isArray(items)) {
    fail(`the loader returned ${typeof items}, not an array of items.`);
  }
  if (items.length > range.limit) {
    fail(
      `the loader returned ${items.length} items for a page of at most ${range.limit}.`,
    );
  }
  return mintRowKeys(
    items as readonly Record<string, unknown>[],
    (fields, i) => {
      const itemId = fields[id];
      if (typeof itemId !== "string") {
        fail(
          `item ${i}'s id (${id}) is ${JSON.stringify(itemId)}, not a string.`,
        );
      }
      const parts = key.of(fields);
      if (
        !Array.isArray(parts) ||
        parts.length !== key.order.length ||
        !parts.every((p) => p === null || typeof p === "string")
      ) {
        fail(
          `paged.key.of(item "${itemId as string}") is ${JSON.stringify(parts)} — ` +
            `it must be ${key.order.length} text (or null) part(s), one per order entry.`,
        );
      }
      return [...parts, itemId as string];
    },
    // The id is the last part, ascending.
    [...key.order, "asc"],
    {
      after: range.after === null ? null : cutParts(range.after),
      until: range.until === null ? null : cutParts(range.until),
    },
    fail,
  );
}

/**
 * Rows in key order, checked and minted their `$key` — the one check behind a
 * paged value's page ({@link pageRowsOf}) and an external collection's
 * window (`serve-on.ts`). `keyOf` reads (and checks) a row's full key — its
 * order parts, the id among them — and `dirs` is one direction per part. The
 * rows must be in strictly ascending key order (so no key twice) and inside
 * `(after, until]`; a violation goes to `fail`, which throws. Each row is
 * handed out with `$key`: the canonical JSON of its key, `null` past
 * `LIVE_ROW_KEY_MAX_BYTES` (no page can be cut there).
 */
export function mintRowKeys(
  rows: readonly Record<string, unknown>[],
  keyOf: (row: Record<string, unknown>, index: number) => LiveCutKey,
  dirs: readonly LiveKeyDirection[],
  range: { after: LiveCutKey | null; until: LiveCutKey | null },
  fail: (detail: string) => never,
): PagedRow[] {
  let previous: LiveCutKey | null = null;
  return rows.map((row, i) => {
    const full = keyOf(row, i);
    if (previous !== null && compareKeyParts(previous, full, dirs) >= 0) {
      fail(
        `the loader's items are not in strictly ascending key order: ` +
          `${JSON.stringify(previous)} then ${JSON.stringify(full)} ` +
          `(a key out of order, or an id twice).`,
      );
    }
    if (
      (range.after !== null && compareKeyParts(full, range.after, dirs) <= 0) ||
      (range.until !== null && compareKeyParts(full, range.until, dirs) > 0)
    ) {
      fail(
        `item ${JSON.stringify(full)} is outside the range asked ` +
          `(after ${JSON.stringify(range.after)}, until ${JSON.stringify(range.until)}).`,
      );
    }
    previous = full;
    const minted = JSON.stringify(full);
    return {
      ...row,
      [LIVE_ROW_KEY]:
        encoder.encode(minted).length > LIVE_ROW_KEY_MAX_BYTES ? null : minted,
    };
  });
}

/**
 * A bytes value's declared `maxBytes`, enforced on its loader: a payload past
 * it is refused `"too-large"` (the declaration's own `refuse`, which declaring
 * `maxBytes` added the code to) rather than shipped. Every other loader is
 * returned as is; a non-`ArrayBuffer` answer is left to the schema, which
 * refuses it loudly.
 */
function boundedBytes<T, P extends Record<string, string>>(
  value: LiveValue<T, P, LiveValueOrigin>,
  loader: (params: P) => Promise<T> | T,
): (params: P) => Promise<T> | T {
  const decl = value as {
    bytes?: true;
    maxBytes?: number;
    refuse?: (code: string, message: string) => Error;
  };
  const max = decl.maxBytes;
  if (decl.bytes !== true || max === undefined) return loader;
  const refuse = decl.refuse;
  if (refuse === undefined) {
    // Unreachable: `liveValue` adds `"too-large"` with `maxBytes`.
    throw new Error(
      `serveValue("${value.key}"): maxBytes without a declared "too-large" refusal.`,
    );
  }
  return async (params) => {
    const payload = await loader(params);
    const size = (payload as { byteLength?: unknown }).byteLength;
    if (typeof size === "number" && size > max) {
      throw refuse(
        "too-large",
        `${size} bytes is over the ${max}-byte limit of "${value.key}".`,
      );
    }
    return payload;
  };
}

/**
 * Derive the runtime options for a value without registering it — so a test
 * can register them on its own `createResourceRuntime` (the
 * `compileCollection` pattern; `registerValue` does both). A typed-query value
 * is `compileQueryValue` (its options over the decoded question), a paged one
 * `compilePagedValue` — one function per form rather than overloads, so a
 * wrong option is reported on its own property, not as "no overload matches".
 */
export function compileValue<
  T,
  P extends Record<string, string>,
  Src extends LiveValueSource,
  O extends LiveValueOrigin,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  value: LivePlainValue<T, P, O> & SnapshotPairing<C> & BytesPairing<Src>,
  // `NoInfer`: `T` / `P` come from the declaration alone — a loader returning
  // `{}` must not widen `T` past the bound rule.
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, Src, R, C>,
): CompiledValue<T, P> {
  return compileValueOf<T, P, P>(value, opts as AnyServeOptions);
}

/** {@link compileValue} for a typed-query value: every hook takes the decoded question `Q`. */
export function compileQueryValue<
  T,
  Q,
  QIn,
  Src extends LiveValueSource,
  O extends LiveValueOrigin,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  value: LiveQueryValue<T, Q, QIn, O> & SnapshotPairing<C> & BytesPairing<Src>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, Src, R, C>,
): CompiledValue<T, LiveQueryParams, Q> {
  return compileValueOf<T, LiveQueryParams, Q>(value, opts as AnyServeOptions);
}

/**
 * A paged value's compiled options: its pages (a keyed external window per
 * page tuple, `tuplesOf(q)` the pages of `q` subscribed now) and — declared
 * `paged.meta` — its meta sibling's.
 */
export type CompiledPagedValue<Item, Meta, Q> = Omit<
  CompiledValue<Item[], LivePagedParams, Q>,
  "options"
> & {
  options: PagedPageOptions<Item>;
  meta: CompiledValue<Meta, LiveQueryParams, Q> | null;
};

/** {@link compileValue} for a paged value: external only, its loader asked one key range. */
export function compilePagedValue<
  Item,
  Meta,
  Q,
  QIn,
  O extends LiveValueOrigin,
  const R extends readonly ExternalServed[] = [],
  C extends PagedChanges = "notified",
  K extends string = never,
>(
  value: LivePagedValue<Item, Meta, Q, QIn, O, K>,
  opts: ServePagedValueOptions<NoInfer<Item>, NoInfer<Meta>, NoInfer<Q>, R, C>,
): CompiledPagedValue<Item, Meta, Q> {
  return compilePagedOf(
    value as unknown as LivePagedValue<
      unknown,
      unknown,
      unknown,
      unknown,
      LiveValueOrigin
    >,
    opts as AnyServeOptions,
  ) as unknown as CompiledPagedValue<Item, Meta, Q>;
}

/**
 * The paged compilation, erased: the pages' and the meta's options over one
 * per-question lifecycle (see the header).
 */
function compilePagedOf(
  value: LivePagedValue<unknown, unknown, unknown, unknown, LiveValueOrigin>,
  opts: AnyServeOptions,
): CompiledPagedValue<unknown, unknown, unknown> {
  if (opts.source !== "external") {
    // Unreachable from typed code (a paged value's options are external only).
    throw new Error(
      `serveValue("${value.key}"): a paged value is served \`source: "external"\` — ` +
        `a paged Postgres list is a liveCollection.`,
    );
  }
  const changes = checkChanges(value, opts);
  // A label the runtime's `_debug` payload shows per key (read-set pane).
  const freshness =
    changes !== undefined ? { freshness: freshnessOf(changes) } : {};
  const stray = (["revalidate", "unbounded"] as const).filter(
    (f) => opts[f] !== undefined,
  );
  if (stray.length > 0) {
    throw new Error(
      `serveValue("${value.key}"): a paged value takes no \`${stray.join("`, `")}\`.`,
    );
  }
  const metaValue = value.meta as
    LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin> | undefined;
  const metaLoader = opts.meta as ((query: unknown) => unknown) | undefined;
  if ((metaValue === undefined) !== (metaLoader === undefined)) {
    // Unreachable from typed code (`meta` is required exactly with `paged.meta`).
    throw new Error(
      metaValue === undefined
        ? `serveValue("${value.key}"): \`meta\` is served only for a value declared \`paged.meta\`.`
        : `serveValue("${value.key}"): the value declares \`paged.meta\` — serve it with \`meta(query)\`.`,
    );
  }
  const codec = value.query;
  const metaKey = (q: string): LiveQueryParams => ({ q });

  // What each question holds subscribed now: its page tuples, and whether
  // its meta tuple is. A question is held while either is non-empty.
  const pages = new Map<string, Map<string, LivePagedParams>>();
  const metaHeld = new Set<string>();
  const held = (q: string) =>
    (pages.get(q)?.size ?? 0) + (metaHeld.has(q) ? 1 : 0);

  let notifyPage: ((params: LivePagedParams) => void) | undefined;
  let notifyMeta: ((params: LiveQueryParams) => void) | undefined;
  /** Every subscribed page of `q`, and its meta — what `notify(q)` reaches. */
  const notifyQuestion = (q: string) => {
    if (
      notifyPage === undefined ||
      (metaValue !== undefined && notifyMeta === undefined)
    ) {
      throw new Error(
        `serveValue("${value.key}"): notify used before the value was registered.`,
      );
    }
    for (const tuple of pages.get(q)?.values() ?? []) notifyPage(tuple);
    if (metaHeld.has(q)) notifyMeta!(metaKey(q));
  };

  const whileSubscribed = opts.whileSubscribed as
    | ((query: unknown, notify: () => void) => StopFn | Promise<StopFn>)
    | undefined;
  const questions =
    whileSubscribed === undefined
      ? undefined
      : pairLifecycle<LiveQueryParams>(({ q }) =>
          whileSubscribed(codec.decodeQuery(q), () => notifyQuestion(q)),
        );
  // A question's async start still resolving. A tuple of it subscribed
  // meanwhile waits for it too, as the first did — the runtime reads a tuple
  // only once its 0→1 hook settles, so no page is loaded before the source
  // is watched (a change in between would reach no tuple).
  const starting = new Map<string, Promise<void>>();
  /** A tuple of `q` subscribed: the question's first starts its lifecycle. */
  const enter = (q: string, add: () => void): void | Promise<void> => {
    const first = held(q) === 0;
    add();
    if (!first) return starting.get(q);
    const started = questions?.onFirstSubscribe(metaKey(q));
    if (started instanceof Promise) {
      // Settled either way: a failed start is reported on the first tuple's
      // subscribe path (the runtime awaits `started` itself); a later tuple
      // only waits for it.
      const settled = started.then(
        () => undefined,
        () => undefined,
      );
      starting.set(q, settled);
      void settled.then(() => {
        if (starting.get(q) === settled) starting.delete(q);
      });
    }
    return started;
  };
  /** A tuple of `q` released: the question's last stops it. */
  const leave = (q: string, remove: () => void): void => {
    remove();
    if (held(q) === 0) questions?.onLastUnsubscribe(metaKey(q));
  };

  const pageLifecycle = {
    onFirstSubscribe: (params: LivePagedParams) =>
      enter(params.q, () => {
        let tuples = pages.get(params.q);
        if (tuples === undefined) pages.set(params.q, (tuples = new Map()));
        tuples.set(tupleKey(params), params);
      }),
    onLastUnsubscribe: (params: LivePagedParams) =>
      leave(params.q, () => {
        const tuples = pages.get(params.q);
        tuples?.delete(tupleKey(params));
        if (tuples?.size === 0) pages.delete(params.q);
      }),
  };
  const pageSubjects: Subjects<LivePagedParams, unknown> = {
    of: (params) => codec.decode(params).query,
    // The question's output re-encodes to its own `q`: a query value's schema
    // must parse idempotently, or no tuple of it passes the gate.
    tuplesOf: (s) => [...(pages.get(codec.encodeQuery(s))?.values() ?? [])],
  };
  const recomputeOn = (opts.recomputeOn ?? []) as readonly RecomputeEntry<
    ExternalServed,
    unknown
  >[];
  const loader = opts.loader as (
    query: unknown,
    range: LiveKeyRange,
  ) => Promise<readonly unknown[]> | readonly unknown[];
  const pagesDependsOn = compileRecomputeOn(value, recomputeOn, pageSubjects);
  const compiledPages: Omit<
    CompiledPagedValue<unknown, unknown, unknown>,
    "meta"
  > = {
    options: {
      // No mode: a page is keyed (the declaration's `keyed`), a window of
      // the page codec's size whose family is its question — every page of
      // one `q` cuts one order, whatever its range and limit, so one page
      // may be seeded from another's items.
      membership: {
        kind: "window",
        limitOf: (params) => codec.decode(params).range.limit,
        familyOf: (params) => params.q,
      },
      loader: async (params: LivePagedParams) => {
        const { query, range } = codec.decode(params);
        return pageRowsOf(value, range, await loader(query, range));
      },
      ...(opts.throttleMs !== undefined ? { debounceMs: opts.throttleMs } : {}),
      ...(pagesDependsOn.length > 0 ? { dependsOn: pagesDependsOn } : {}),
      ...pageLifecycle,
      ...freshness,
    },
    external: true,
    ...(changes !== undefined ? { changes } : {}),
    tuplesOf: (subject) => pageSubjects.tuplesOf(subject),
    bindNotify(fn) {
      notifyPage = fn;
    },
  };

  let compiledMeta: CompiledValue<unknown, LiveQueryParams, unknown> | null =
    null;
  if (metaValue !== undefined && metaLoader !== undefined) {
    const metaSubjects: Subjects<LiveQueryParams, unknown> = {
      of: (params) => metaValue.query.decode(params),
      // Like the pages: the meta tuple of a question, while it is subscribed.
      tuplesOf: (s) => {
        const tuple = metaValue.query.encode(s);
        return metaHeld.has(tuple.q) ? [tuple] : [];
      },
    };
    const metaDependsOn = compileRecomputeOn(
      metaValue,
      recomputeOn,
      metaSubjects,
    );
    compiledMeta = {
      options: {
        mode: metaValue.load === "on-demand" ? "invalidate" : "push",
        loader: (params: LiveQueryParams) =>
          metaLoader(metaValue.query.decode(params)),
        ...(opts.throttleMs !== undefined
          ? { debounceMs: opts.throttleMs }
          : {}),
        ...(metaDependsOn.length > 0 ? { dependsOn: metaDependsOn } : {}),
        onFirstSubscribe: ({ q }: LiveQueryParams) =>
          enter(q, () => metaHeld.add(q)),
        onLastUnsubscribe: ({ q }: LiveQueryParams) =>
          leave(q, () => metaHeld.delete(q)),
        ...freshness,
      },
      external: true,
      ...(changes !== undefined ? { changes } : {}),
      tuplesOf: (subject) => metaSubjects.tuplesOf(subject),
      bindNotify(fn) {
        notifyMeta = fn;
      },
    };
  }
  return { ...compiledPages, meta: compiledMeta };
}

/**
 * The one compilation behind every form, erased: the declaration says which
 * form it is (`query`, `paged`), and the typed entry points above have
 * already checked the options against it.
 */
export function compileValueOf<T, P extends Record<string, string>, S>(
  value: LiveValue<T, P, LiveValueOrigin>,
  opts: AnyServeOptions,
): CompiledValue<T, P, S> {
  const unbounded = (opts as { unbounded?: { reason: string } }).unbounded;
  if (unbounded !== undefined && unbounded.reason.trim() === "") {
    throw new Error(
      `serveValue("${value.key}"): \`unbounded.reason\` is empty — say why this ` +
        `value is not a liveCollection.`,
    );
  }
  const external = opts.source === "external";
  const changes = checkChanges(value, opts);
  if ((value as { paged?: unknown }).paged !== undefined) {
    // Unreachable from typed code: a paged value compiles through `compilePagedValue`.
    throw new Error(
      `serveValue("${value.key}"): a paged value compiles through compilePagedValue.`,
    );
  }
  const bytes = (value as { bytes?: true }).bytes === true;
  if (bytes && !external) {
    // Unreachable from typed code (`BytesPairing`).
    throw new Error(
      `serveValue("${value.key}"): a bytes value is served \`source: "external"\` — ` +
        `a Postgres row is not a binary payload.`,
    );
  }
  const subjects = subjectsOf<P, S>(value);

  let notify: ((params: P) => void) | undefined;
  const notifyFor = (params: P) => () => {
    if (notify === undefined) {
      throw new Error(
        `serveValue("${value.key}"): notify used before the value was registered.`,
      );
    }
    notify(params);
  };
  const whileSubscribed = opts.whileSubscribed as
    ((subject: S, notify: () => void) => StopFn | Promise<StopFn>) | undefined;
  const paired =
    whileSubscribed === undefined
      ? undefined
      : pairLifecycle<P>((params) =>
          // The db arm's hook takes the subject only; the extra argument is
          // never passed to it.
          external
            ? whileSubscribed(subjects.of(params), notifyFor(params))
            : (whileSubscribed as (subject: S) => StopFn | Promise<StopFn>)(
                subjects.of(params),
              ),
        );
  const lifecycle = paired ?? {};

  const dependsOn = compileRecomputeOn<P, S>(
    value,
    (opts.recomputeOn ?? []) as readonly RecomputeEntry<ExternalServed, S>[],
    subjects,
  );

  const loader = boundedBytes(
    value,
    loaderOf(value, opts.loader as (...args: never[]) => unknown),
  );
  const revalidate = opts.revalidate as
    ((subject: S) => Promise<string>) | undefined;
  return {
    options: {
      // Read off the DECLARATION (`liveValue`'s `load`), never a serve option:
      // the client reads the same field, so the two halves cannot disagree.
      // The runtime's own `"invalidate"` is the named opt-in's spelling.
      mode: value.load === "on-demand" ? "invalidate" : "push",
      // Only the params: the runtime's scoped-refill `ctx` is a keyed concept.
      loader: (params: P) => loader(params),
      ...(opts.throttleMs !== undefined ? { debounceMs: opts.throttleMs } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(revalidate === undefined
        ? {}
        : (value as { query?: unknown }).query === undefined
          ? {
              revalidate: revalidate as unknown as (
                params: P,
              ) => Promise<string>,
            }
          : { revalidate: (params: P) => revalidate(subjects.of(params)) }),
      ...lifecycle,
      // A label the runtime's `_debug` payload shows per key (read-set pane).
      ...(changes !== undefined ? { freshness: freshnessOf(changes) } : {}),
    },
    external,
    ...(changes !== undefined ? { changes } : {}),
    ...(unbounded !== undefined ? { unbounded } : {}),
    tuplesOf: (subject) => subjects.tuplesOf(subject),
    bindNotify(fn) {
      notify = fn;
    },
  };
}

/** `changes` as the runtime's debug label: its arm and, off `"notified"`, its reason. */
export function freshnessOf(changes: LiveValueChanges): {
  kind: "notified" | "immutable" | "fixed" | "snapshot";
  reason?: string;
} {
  if (changes === "notified") return { kind: "notified" };
  const kind = changesKind(changes);
  const reason = (changes as Record<string, { reason: string }>)[kind]!.reason;
  return { kind, reason };
}

/** The arm a `changes` names (`"notified"`, or the one key of its object form). */
function changesKind(
  changes: LiveValueChanges,
): "notified" | "immutable" | "fixed" | "snapshot" {
  if (changes === "notified") return "notified";
  if ("immutable" in changes) return "immutable";
  if ("fixed" in changes) return "fixed";
  return "snapshot";
}

/**
 * Everything tsc pairs about `changes`, checked again for an untyped caller —
 * and the one check tsc cannot make (a blank reason). Returns the declared
 * `changes` (absent on the db arm).
 *
 * - a db value declares none; an external one must;
 * - `{ immutable | fixed | snapshot }` names exactly one arm, with a reason;
 * - only `"notified"` takes `whileSubscribed` / `recomputeOn` / `throttleMs`;
 * - `{ snapshot }` ⇔ the value is declared `load: "snapshot"`, and a snapshot
 *   takes no `revalidate` — its every HTTP read runs the loader.
 */
function checkChanges(
  value: { key: string; snapshot?: true },
  opts: AnyServeOptions,
): LiveValueChanges | undefined {
  const where = `serveValue("${value.key}")`;
  const changes = opts.changes;
  if (opts.source !== "external") {
    if (changes !== undefined) {
      throw new Error(
        `${where}: \`changes\` is the external arm's — a db value is told of ` +
          `every change by the change feed.`,
      );
    }
    if (value.snapshot === true) {
      throw new Error(
        `${where}: a \`load: "snapshot"\` value is served \`source: ` +
          `"external"\` with \`changes: { snapshot: { reason } }\`.`,
      );
    }
    return undefined;
  }
  if (changes === undefined) {
    throw new Error(
      `${where}: an external value must declare \`changes\` — "notified", ` +
        `or { immutable | fixed | snapshot: { reason } }.`,
    );
  }
  if (changes !== "notified") {
    const arms = Object.keys(changes);
    const arm = arms[0];
    const reason = (
      changes as Record<string, { reason?: unknown } | undefined>
    )[arm ?? ""]?.reason;
    if (
      arms.length !== 1 ||
      (arm !== "immutable" && arm !== "fixed" && arm !== "snapshot") ||
      typeof reason !== "string"
    ) {
      throw new Error(
        `${where}: \`changes\` ${JSON.stringify(changes)} is not "notified" ` +
          `or one of { immutable | fixed | snapshot: { reason } }.`,
      );
    }
    if (reason.trim() === "") {
      throw new Error(
        `${where}: \`changes.${arm}.reason\` is empty — say why this value ` +
          `is never told of a change.`,
      );
    }
    const hooks = (
      ["whileSubscribed", "recomputeOn", "throttleMs"] as const
    ).filter((h) => opts[h] !== undefined);
    if (hooks.length > 0) {
      throw new Error(
        `${where}: \`${hooks.join("`, `")}\` reacts to a change signal, and a ` +
          `\`changes: { ${arm} }\` value has none — declare \`changes: "notified"\`.`,
      );
    }
  }
  const snapshot = changes !== "notified" && "snapshot" in changes;
  if (snapshot !== (value.snapshot === true)) {
    throw new Error(
      snapshot
        ? `${where}: \`changes: { snapshot }\` needs the value declared ` +
            `\`load: "snapshot"\` — the client reads it over HTTP, on demand.`
        : `${where}: a \`load: "snapshot"\` value declares ` +
            `\`changes: { snapshot: { reason } }\`.`,
    );
  }
  if (snapshot && opts.revalidate !== undefined) {
    throw new Error(
      `${where}: a snapshot takes no \`revalidate\` — every read re-measures.`,
    );
  }
  return changes;
}

/** The options of any form, erased — the implementation signatures' view. */
export interface AnyServeOptions {
  source: LiveValueSource;
  changes?: LiveValueChanges;
  loader: unknown;
  meta?: unknown;
  throttleMs?: number;
  recomputeOn?: readonly unknown[];
  revalidate?: unknown;
  whileSubscribed?: unknown;
  unbounded?: { reason: string };
}

/**
 * `recomputeOn` → `dependsOn`. A bare upstream recomputes every subscribed
 * tuple — except on a param-less value, whose one tuple `{}` is recomputed
 * whether or not a tab holds it right now: an L2-persisted value, or one a
 * downstream maps, must follow its upstream with no subscriber. (A tab's old
 * copy needs no recompute to be refused: the runtime opens every subscription
 * span with a fresh version.) A mapped entry names a SUBJECT (a question, for a
 * query value), recomputing the tuples it reaches.
 */
function compileRecomputeOn<P extends Record<string, string>, S>(
  value: { key: string; params: readonly string[] },
  entries: readonly RecomputeEntry<ExternalServed, S>[],
  subjects: Subjects<P, S>,
): DependsOnEntry<P>[] {
  return entries.map((entry): DependsOnEntry<P> => {
    if ("value" in entry) {
      const toSubject = entry.params;
      return {
        resource: entry.value,
        map: (upstreamParams: unknown) =>
          subjects.tuplesOf(
            toSubject(upstreamParams as UpstreamParams<ExternalServed>),
          ),
      };
    }
    const upstream = entry as ExternalServed;
    if (value.params.length === 0) {
      return { resource: upstream, map: () => [{} as P] };
    }
    return { resource: upstream, toSubscribed: true };
  });
}

/**
 * Compile and register a value on `runtime`, and bind its `notify` into the
 * lifecycle. Returns the runtime resource (external ⇒ with `notify`).
 */
export function registerValue<
  T,
  P extends Record<string, string>,
  O extends LiveValueOrigin,
  Src extends LiveValueSource,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  runtime: LiveRuntime,
  value: LivePlainValue<T, P, O> & SnapshotPairing<C> & BytesPairing<Src>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, Src, R, C>,
): Registered<T, P> {
  return registerValueOf<T, P, P>(runtime, value, opts as AnyServeOptions);
}

/** {@link registerValue} for a typed-query value (see {@link compileQueryValue}). */
export function registerQueryValue<
  T,
  Q,
  QIn,
  O extends LiveValueOrigin,
  Src extends LiveValueSource,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  runtime: LiveRuntime,
  value: LiveQueryValue<T, Q, QIn, O> & SnapshotPairing<C> & BytesPairing<Src>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, Src, R, C>,
): Registered<T, LiveQueryParams, Q> {
  return registerValueOf<T, LiveQueryParams, Q>(
    runtime,
    value,
    opts as AnyServeOptions,
  );
}

/** {@link registerValue} for a paged value: its pages and its meta sibling, each with its notify bound. */
export function registerPagedValue<
  Item,
  Meta,
  Q,
  QIn,
  O extends LiveValueOrigin,
  const R extends readonly ExternalServed[] = [],
  C extends PagedChanges = "notified",
  K extends string = never,
>(
  runtime: LiveRuntime,
  value: LivePagedValue<Item, Meta, Q, QIn, O, K>,
  opts: ServePagedValueOptions<NoInfer<Item>, NoInfer<Meta>, NoInfer<Q>, R, C>,
): RegisteredPaged<Item, Meta, Q> {
  return registerPagedOf(
    runtime,
    value as unknown as LivePagedValue<
      unknown,
      unknown,
      unknown,
      unknown,
      LiveValueOrigin
    >,
    opts as AnyServeOptions,
  ) as unknown as RegisteredPaged<Item, Meta, Q>;
}

/** The paged registration, erased (see {@link compilePagedOf}). */
export function registerPagedOf(
  runtime: LiveRuntime,
  value: LivePagedValue<unknown, unknown, unknown, unknown, LiveValueOrigin>,
  opts: AnyServeOptions,
): RegisteredPaged<unknown, unknown, unknown> {
  const compiled = compilePagedOf(value, opts);
  // A paged value's descriptor is a keyed contract (`keyed.keyOf`, its id).
  const pages = runtime.defineExternalResource(
    value as unknown as KeyedResourceContract<unknown[], LivePagedParams>,
    compiled.options,
  );
  compiled.bindNotify((params) => pages.notify(params));
  const metaValue = value.meta as
    LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin> | undefined;
  let meta: RegisteredPaged<unknown, unknown, unknown>["meta"] = null;
  if (metaValue !== undefined && compiled.meta !== null) {
    const resource = runtime.defineExternalResource(
      metaValue as unknown as ResourceContract<unknown, LiveQueryParams> & {
        keyed?: never;
      },
      compiled.meta.options,
    );
    compiled.meta.bindNotify((params) => resource.notify(params));
    meta = { resource, compiled: compiled.meta };
  }
  return { resource: pages, compiled, meta };
}

/** What `registerPagedValue` returns: the pages' resource, the meta's, and their compiled options. */
export interface RegisteredPaged<Item, Meta, Q> {
  resource: ExternalResource<Item[], LivePagedParams>;
  compiled: CompiledPagedValue<Item, Meta, Q>;
  meta: {
    resource: ExternalResource<Meta, LiveQueryParams>;
    compiled: CompiledValue<Meta, LiveQueryParams, Q>;
  } | null;
}

/** The registration behind every form, erased (see {@link compileValueOf}). */
export function registerValueOf<T, P extends Record<string, string>, S>(
  runtime: LiveRuntime,
  value: LiveValue<T, P, LiveValueOrigin>,
  opts: AnyServeOptions,
): Registered<T, P, S> {
  const compiled = compileValueOf<T, P, S>(value, opts);
  // A `LiveValue` is structurally a non-keyed `ResourceContract` (`keyed?: never`).
  const contract = value as ResourceContract<T, P> & { keyed?: never };
  if (compiled.external) {
    const resource = runtime.defineExternalResource(contract, compiled.options);
    compiled.bindNotify((params) => resource.notify(params));
    return { resource, compiled };
  }
  const resource = runtime.defineResource(contract, compiled.options);
  return { resource, compiled };
}

/** What `registerValue` returns: the runtime resource and its compiled options. */
export interface Registered<T, P extends Record<string, string>, S = P> {
  resource: Resource<T, P> | ExternalResource<T, P>;
  compiled: CompiledValue<T, P, S>;
}
