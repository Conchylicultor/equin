import type {
  DependsOnEntry,
  ExternalResource,
  ExternalWindowPolicy,
  KeyedResourceContract,
  KeyedServerResourceOptions,
  Resource,
  ResourceContract,
  ServerResourceOptions,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  LIVE_ROW_KEY,
  LIVE_ROW_KEY_MAX_BYTES,
  type LiveCutKey,
  type LiveKeyRange,
  type LivePagedKey,
  type LivePagedParams,
  type LivePagedValue,
  type LivePlainValue,
  type LiveQueryParams,
  type LiveQueryValue,
  type LiveValue,
  type LiveValueOrigin,
} from "@plugins/network/plugins/live/core";
import { compareRowKeys, inRange } from "./key-order";

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
  /** The collection-shaped value's recorded reason (db arm only). */
  unbounded?: { reason: string };
  /** `[key]` — symmetric with `ServedCollection.keys`. */
  keys: string[];
};

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
 * `whileSubscribed` per arm: an external value is handed `notify` for the
 * subscribed tuple; a db value is driven by the change feed alone, so its hook
 * takes the params only (a second parameter is a tsc error).
 */
type WhileSubscribedArm<Src extends LiveValueSource, P> = Src extends "external"
  ? {
      /**
       * Start something for as long as a tuple has a subscriber (a watcher);
       * return what stops it. `notify` recomputes THIS tuple. Runs on the
       * tuple's first subscriber; its stop runs on the last unsubscribe —
       * after the start resolves, if the unsubscribe comes first.
       */
      whileSubscribed?: (
        params: P,
        notify: () => void,
      ) => StopFn | Promise<StopFn>;
    }
  : {
      /**
       * Start something for as long as a tuple has a subscriber (a memo's
       * lifetime); return what stops it. No `notify`: a db value is driven by
       * the change feed alone.
       */
      whileSubscribed?: (params: P) => StopFn | Promise<StopFn>;
    };

/**
 * The options every served value takes, over `S` — the SUBJECT its hooks are
 * handed: the params tuple of a plain value, the decoded question of a
 * typed-query or paged one — and `L`, its loader.
 */
type ServeOptionsBase<
  T,
  S,
  Src extends LiveValueSource,
  R extends readonly ExternalServed[],
  L,
> = {
  /** Where the value's truth lives (see the header). Required. */
  source: Src;
  /** Read the value for one tuple. Parsed against the declaration's schema. */
  loader: L;
  /**
   * Flush this value at most once per window (ms): the first change arms a
   * trailing timer that later changes do not re-arm, so a burst (a rebase
   * rewriting a ref) costs one recompute. A flush already happening for
   * another resource drains it early.
   */
  throttleMs?: number;
  /**
   * Upstream served values whose change recomputes this one — see
   * {@link RecomputeEntry}.
   */
  recomputeOn?: RecomputeOn<R, S>;
} & BoundArm<Src, T> &
  WhileSubscribedArm<Src, S>;

export type ServeValueOptions<
  T,
  P,
  Src extends LiveValueSource,
  R extends readonly ExternalServed[] = [],
> = ServeOptionsBase<T, P, Src, R, (params: P) => Promise<T> | T> & {
  /**
   * Conditional-revalidation signature (an ETag): a cheap over-approximation
   * of "did the value change?" the read path compares before running the
   * loader. Read path only.
   */
  revalidate?: (params: P) => Promise<string>;
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
> = ServeOptionsBase<
  Item[],
  Q,
  "external",
  R,
  (query: Q, range: LiveKeyRange) => Promise<readonly Item[]> | readonly Item[]
> & { revalidate?: never } & MetaOption<Meta, Q>;

/** `meta` exactly when the declaration has `paged.meta`. */
type MetaOption<Meta, Q> = [Meta] extends [undefined]
  ? { meta?: never }
  : {
      /** The question's per-question fact (a total), served as `value.meta`. */
      meta: (query: Q) => Promise<Meta> | Meta;
    };

/**
 * A value's two-arg runtime options: never routed (`reach`) — a value's
 * loader is opaque, so the read-set it captures routes it (`source: "db"`), or
 * its own `notify` does (`"external"`).
 */
type ValueOptions<T, P extends Record<string, string>> = ServerResourceOptions<
  T,
  P
> & { reach?: never };

/** The runtime's two-arg options for a value, plus which factory registers it. */
export interface CompiledValue<T, P extends Record<string, string>, S = P> {
  options: ValueOptions<T, P>;
  external: boolean;
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

/** A runtime's two register primitives — server-core's or central-core's. */
export interface ValueRuntime {
  defineResource<T, P extends Record<string, string>>(
    contract: ResourceContract<T, P> & { keyed?: never },
    opts: ValueOptions<T, P>,
  ): Resource<T, P>;
  defineExternalResource<T, P extends Record<string, string>>(
    contract: ResourceContract<T, P> & { keyed?: never },
    opts: ValueOptions<T, P>,
  ): ExternalResource<T, P>;
  defineExternalResource<T>(
    contract: KeyedResourceContract<T[], LivePagedParams>,
    opts: PagedPageOptions<T>,
  ): ExternalResource<T[], LivePagedParams>;
}

/** A canonical per-tuple key (sorted entries), for the lifecycle pairing. */
function tupleKey(params: Record<string, string>): string {
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
type PagedRow = Record<string, unknown> & { [LIVE_ROW_KEY]: string | null };

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
  let previous: LiveCutKey | null = null;
  return items.map((item, i) => {
    const fields = item as Record<string, unknown>;
    const itemId = fields[id];
    if (typeof itemId !== "string") {
      fail(
        `item ${i}'s id (${id}) is ${JSON.stringify(itemId)}, not a string.`,
      );
    }
    const parts = key.of(item);
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
    const full: LiveCutKey = [...parts, itemId as string];
    if (previous !== null && compareRowKeys(previous, full, key.order) >= 0) {
      fail(
        `the loader's items are not in strictly ascending key order: ` +
          `${JSON.stringify(previous)} then ${JSON.stringify(full)} ` +
          `(a key out of order, or an id twice).`,
      );
    }
    if (!inRange(full, range, key.order)) {
      fail(
        `item ${JSON.stringify(full)} is outside the range asked ` +
          `(after ${JSON.stringify(range.after)}, until ${JSON.stringify(range.until)}).`,
      );
    }
    previous = full;
    const minted = JSON.stringify(full);
    return {
      ...fields,
      [LIVE_ROW_KEY]:
        encoder.encode(minted).length > LIVE_ROW_KEY_MAX_BYTES ? null : minted,
    };
  });
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
>(
  value: LivePlainValue<T, P, O>,
  // `NoInfer`: `T` / `P` come from the declaration alone — a loader returning
  // `{}` must not widen `T` past the bound rule.
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, Src, R>,
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
>(
  value: LiveQueryValue<T, Q, QIn, O>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, Src, R>,
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
>(
  value: LivePagedValue<Item, Meta, Q, QIn, O>,
  opts: ServePagedValueOptions<NoInfer<Item>, NoInfer<Meta>, NoInfer<Q>, R>,
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
    },
    external: true,
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
      },
      external: true,
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
  if ((value as { paged?: unknown }).paged !== undefined) {
    // Unreachable from typed code: a paged value compiles through `compilePagedValue`.
    throw new Error(
      `serveValue("${value.key}"): a paged value compiles through compilePagedValue.`,
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

  const loader = loaderOf(value, opts.loader as (...args: never[]) => unknown);
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
    },
    external,
    ...(unbounded !== undefined ? { unbounded } : {}),
    tuplesOf: (subject) => subjects.tuplesOf(subject),
    bindNotify(fn) {
      notify = fn;
    },
  };
}

/** The options of any form, erased — the implementation signatures' view. */
export interface AnyServeOptions {
  source: LiveValueSource;
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
>(
  runtime: ValueRuntime,
  value: LivePlainValue<T, P, O>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, Src, R>,
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
>(
  runtime: ValueRuntime,
  value: LiveQueryValue<T, Q, QIn, O>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, Src, R>,
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
>(
  runtime: ValueRuntime,
  value: LivePagedValue<Item, Meta, Q, QIn, O>,
  opts: ServePagedValueOptions<NoInfer<Item>, NoInfer<Meta>, NoInfer<Q>, R>,
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
  runtime: ValueRuntime,
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
  runtime: ValueRuntime,
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
