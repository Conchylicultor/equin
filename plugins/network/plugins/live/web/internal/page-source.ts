import { z } from "zod";
import type { ResourceDescriptor } from "@plugins/primitives/plugins/live-state/web";
import type {
  LivePagedPages,
  LivePagedParams,
  LiveQuery,
  LiveScrollCollection,
  LiveValueOrigin,
  LiveWindowParams,
} from "@plugins/network/plugins/live/core";
import type { Page } from "../../shared/page-plan";

// The seam between the paged-read hook (`use-pages.ts`) and what it reads: a
// source says which resource a page is one tuple of, how a question and a page
// encode into that tuple, how big a page is, and how a row names itself. The
// hook and the plan (`shared/page-plan.ts`) know nothing else of the source,
// so another kind of source plugs in here, never into them. Two do: a scroll
// collection's window, and a paged value's pages — each page a keyed window
// on the server, so either may be sent seeded (`derive`).

/** A paged read's query: the window query without `limit` — the pages own the limits. */
export type LivePagesQuery<F, S extends string> = Omit<
  LiveQuery<F, S>,
  "limit"
>;

/** One source of key-range pages, as the paged-read hook reads it. */
export interface PageSource<Row, Q, P extends Record<string, string>> {
  /** The source's name — what its log lines and its reset key tell it apart by. */
  key: string;
  /** The resource each page is one tuple of. */
  descriptor: ResourceDescriptor<Row[], P>;
  /**
   * The question's canonical identity, without limit or cuts: two questions
   * with the same `base` are one plan. It never names what a question carries
   * that changes no row (a collection query's `columns`).
   */
  base(query: Q): string;
  /** `step` — page 0's limit, and the step a page grows by — and the bound on any page's limit. */
  limits: { step: number; maxLimit: number };
  /**
   * The tuple reading `page` of `query`. INVARIANT: page 0 at `step` of the
   * empty question is byte-identical to the source's plain default tuple — the
   * one the boot snapshot hydrates — so a paged reader and a plain one share it.
   */
  params(query: Q, page: Page): P;
  /**
   * What a question brings that `base` leaves out and the plan must still
   * follow: a collection query's column sets (compared by identity — a
   * change of them alone keeps the plan, read from then on with the new
   * query). `undefined` for a source whose `base` is its whole question.
   */
  columnsOf(query: Q): readonly unknown[] | undefined;
  /** The row field a row is identified by (each row also carries `$key`, its cut key). */
  idField: string;
}

/** A scroll collection's page source. */
export type CollectionPageSource<Row, F, S extends string> = PageSource<
  Row,
  LivePagesQuery<F, S>,
  LiveWindowParams
>;

/** A paged value's page source: its question is the schema's input. */
export type ValuePageSource<Item, QIn> = PageSource<Item, QIn, LivePagedParams>;

/**
 * Any paged value's pages, erased — the implementation signature's view
 * (`any`: a generic item's schema is invariant, so no `LivePagedPages<Item,
 * …>` is a `LivePagedPages<unknown, …>` while `Item` is unresolved).
 */
// biome-ignore lint/suspicious/noExplicitAny: see above.
type AnyPagedValue = LivePagedPages<any, any, any, LiveValueOrigin>;

/** One source per declaration, so its identity is stable across renders. */
const sources = new WeakMap<
  object,
  PageSource<unknown, unknown, Record<string, string>>
>();

/**
 * The page source of a scroll collection — its window tuples, cut at server-
 * minted row keys — or of a paged value — its page tuples, cut the same way —
 * or, for `null`, the detached source a read with nothing to read stands on
 * (its hook order stays fixed; nothing is ever encoded or read through it).
 */
export function pageSourceOf<Row, F, S extends string>(
  source: LiveScrollCollection<Row, F, S> | null,
): CollectionPageSource<Row, F, S>;
export function pageSourceOf<Item, Q, QIn>(
  source: LivePagedPages<Item, Q, QIn, LiveValueOrigin> | null,
): ValuePageSource<Item, QIn>;
export function pageSourceOf(
  // biome-ignore lint/suspicious/noExplicitAny: erased as `AnyPagedValue` is.
  source: LiveScrollCollection<any, any, any> | AnyPagedValue | null,
): unknown {
  if (source === null) {
    return DETACHED as unknown as PageSource<
      unknown,
      unknown,
      Record<string, string>
    >;
  }
  let cached = sources.get(source);
  if (cached === undefined) {
    cached = ("live" in source
      ? valueSource(source)
      : collectionSource(source)) as unknown as PageSource<
      unknown,
      unknown,
      Record<string, string>
    >;
    sources.set(source, cached);
  }
  return cached;
}

function valueSource<Item, Q, QIn>(
  value: LivePagedPages<Item, Q, QIn, LiveValueOrigin>,
): ValuePageSource<Item, QIn> {
  const codec = value.query;
  return {
    key: value.key,
    descriptor: value,
    // The value and the question's canonical `q` — two values' questions may
    // encode alike, and a plan's cuts are one value's row keys. A question
    // carries nothing that changes no item, so its `q` is all of it.
    base: (query) => JSON.stringify([value.key, codec.encodeQuery(query)]),
    limits: { step: value.paged.limit, maxLimit: value.paged.maxLimit },
    // Page 0 at the step is `{ q, limit }` — the tuple a plain read names.
    params: (query, page) => codec.encode(query, page),
    columnsOf: () => undefined,
    idField: value.paged.id,
  };
}

function collectionSource<Row, F, S extends string>(
  collection: LiveScrollCollection<Row, F, S>,
): CollectionPageSource<Row, F, S> {
  const codec = collection.window.window;
  return {
    key: collection.key,
    descriptor: collection.window as unknown as ResourceDescriptor<
      Row[],
      LiveWindowParams
    >,
    // The collection and the query's encoding at the default limit, with no
    // cut — two collections' queries may encode alike, and a plan's cuts are
    // one collection's row keys. The column sets a query brings (`columns`)
    // are not in it: they only name what `where` / `orderBy` may read, and a
    // row carries the collection's whole projection whichever the query
    // brings.
    base: (query) => JSON.stringify([collection.key, codec.encode(query)]),
    limits: { step: codec.defaultLimit, maxLimit: codec.maxLimit },
    params: (query, page) =>
      codec.encode(
        { ...query, limit: page.limit },
        {
          ...(page.after !== null ? { after: page.after } : {}),
          ...(page.until !== null ? { until: page.until } : {}),
        },
      ),
    columnsOf: (query) => query.columns,
    idField: collection.id,
  };
}

const DETACHED: CollectionPageSource<never, unknown, string> = {
  key: "",
  descriptor: {
    key: "network.live.pages:detached",
    schema: z.array(z.never()),
    validateParams: () => {
      throw new Error("a detached paged read subscribes nothing");
    },
  },
  base: () => {
    throw new Error("a detached paged read has no query");
  },
  limits: { step: 1, maxLimit: 2 },
  params: () => {
    throw new Error("a detached paged read encodes nothing");
  },
  columnsOf: () => undefined,
  idField: "",
};
