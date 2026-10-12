import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useResources,
  type PagedResourceResult,
  type ResourceDerivation,
  type ResourceError,
  type ResourceTupleResult,
} from "@plugins/primitives/plugins/live-state/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import {
  LIVE_ROW_KEY,
  type LivePagedValue,
  type LiveQuery,
  type LiveScrollCollection,
  type LiveValueOrigin,
} from "@plugins/network/plugins/live/core";
import { withoutWindowFields } from "./window-fields";
import {
  createCrossPageGaps,
  type CrossPageGaps,
  type GapPage,
} from "./cross-page-gaps";
import {
  pageSourceOf,
  type LivePagesQuery,
  type PageSource,
} from "./page-source";
import type { VisibleRange } from "./visible-range";
import {
  assemble,
  loadMore as loadMorePages,
  pageKey,
  reconcile,
  startPages,
  TRUNCATION_DETAIL,
  type Page,
  type PageEntry,
  type PageLimits,
  type PageObservation,
  type PagePlaceholder,
  type PagePlan,
  type PagesTruncation,
} from "../../shared/page-plan";

// The paged read `useLive` dispatches a `scroll: true` collection's window and
// a paged value to — a live read built from KEY-RANGE pages
// (`shared/page-plan`), each one bounded tuple. The hook reads its source
// through the page-source seam (`./page-source`): which resource a page is a
// tuple of, and how it encodes. The plan decides the pages and
// which of them are live; this hook reads the live ones (`useResources`,
// released at once when a page leaves the live set), feeds the plan what
// each holds, and assembles the rows — split off from each row's `$key`,
// which the plan cuts at and a consumer never sees.
//
// Which pages are live is the viewport's call, and the viewport is optional:
// - WITH one (`useLive(source, q, { viewport })`, a DataView's read) the
//   pages near it are live and the rest released, held stale up to a budget,
//   past which they are placeholders before and after the rows — depth
//   unbounded;
// - WITHOUT one (`useLive(source, q)`, a plain reader that cannot say which
//   rows are on screen) every page is live, so the read is capped: it never
//   pages past `maxLimit` rows, and drops the pages a live insert pushes
//   beyond it — and it hands out the plain list result every window read has.

/**
 * The stale budget, in steps (`default.limit`s): how many rows the released
 * pages of one read keep between them before the farthest become
 * placeholders — a few pages either side of the live band, so a scroll back
 * shows rows at once, while what a read holds stays O(viewport + budget)
 * however deep it went.
 */
const STALE_STEPS = 8;

/** `useLive(source, query, options)` — a paged read kept live by a measured viewport. */
export interface LivePagesOptions {
  /**
   * Which of the read's rows are on screen — measured by the surface drawing
   * them (data-view's `usePagesViewport`), naming a page drawn as a
   * placeholder by its placeholder's `key`. Pages near it are live; pages far
   * from it are released and keep their rows, stale, or — past the stale
   * budget — are placeholders.
   */
  viewport: VisibleRange;
  /**
   * Which query changes keep the previous rows on screen until the new query's
   * first page settles: a change whose `resetKey` equals the previous one's is
   * such a keep-previous handoff (a search typed into a list); any other
   * change starts over, loading. Absent: every change starts over.
   */
  resetKey?: string;
}

/** A page's read failing under rows that stay on screen. */
export interface LivePageError<C extends string = string> {
  /** The failing read's identity — unique among the result's errors (a React key). */
  key: string;
  /** The last row before the failing page; `null` = it is the head. */
  afterRowId: string | null;
  error: ResourceError<C>;
  /**
   * Paging is stopped on it — the last page's own read, or a failure that
   * holds the read short of its end — so it belongs where paging stopped (a
   * list's footer), not above the rows.
   */
  blocksPaging: boolean;
  /** Re-read that page. Never `loadMore`. */
  retry: () => void;
}

/**
 * A page drawn as one placeholder: a released page past the stale budget (its
 * rows dropped), or one that cannot join the rows drawn — never a row value.
 * It stands in for `rows` rows, so the surface keeps the height they had;
 * drawn where the viewport sees it, and reported by `key`, it is subscribed
 * again and replaced by its rows once they land.
 */
export interface LivePagePlaceholder {
  /** What the viewport names it by — unique among the read's placeholders and rows. */
  key: string;
  rows: number;
}

/**
 * A paged read kept live by a viewport, in the states every read has:
 * `loading` until the first page has rows, `error` when that first page
 * failed with nothing to show (its `refetch` re-reads it), then `ready` — for
 * good: a failure under rows already shown is a `pageErrors` entry, never the
 * error arm.
 */
export type LivePagesResult<Row, C extends string = string> =
  | { status: "loading" }
  | { status: "error"; error: ResourceError<C>; refetch: () => Promise<void> }
  | {
      status: "ready";
      rows: readonly Row[];
      /** Every row of the query is loaded (nothing past the last page). */
      exhausted: boolean;
      /** `loadMore()` would add rows. */
      canGrow: boolean;
      /** A `loadMore()` is in flight; the rows shown are the previous ones. */
      growing: boolean;
      loadMore: () => void;
      /** The last page is full and cannot be paged past (an over-long sort key). */
      truncated: false | { reason: PagesTruncation };
      pageErrors: readonly LivePageError<C>[];
      /**
       * The pages drawn as placeholders: those before `rows` and those after
       * — never between two rows. Empty until the read is scrolled past the
       * stale budget.
       */
      placeholders: {
        before: readonly LivePagePlaceholder[];
        after: readonly LivePagePlaceholder[];
      };
    };

/** One row as the plan holds it: its id, its cut key and the wire row itself. */
interface RowEntry extends PageEntry {
  row: unknown;
}

interface Plan<Q> {
  /** The source's canonical question (no limit, no cuts) this plan's pages read. */
  base: string;
  query: Q;
  state: PagePlan<RowEntry>;
}

interface HookState<Q> {
  /** The source's key and the caller's `resetKey` (a new source always starts over). */
  resetKey: string;
  current: Plan<Q> | null;
  /** The previous query's rows, kept while the current one's head loads (a keep-previous handoff). */
  previous: Plan<Q> | null;
  /** The last full page that could not split — reported once, from an effect. */
  collapse: { seq: number; reason: string; at: number } | null;
  /**
   * The rest pages the last overflow splits minted, each batch in the plan at
   * its `base` — timed from an effect until each one's own read first settles.
   * Appended, not replaced (the last `OVERFLOW_BATCHES` kept): two renders can
   * each split before one commit runs the effect, and the effect takes every
   * batch past the last `seq` it saw.
   */
  overflowed: {
    seq: number;
    batches: readonly { seq: number; base: string; pages: readonly Page[] }[];
  } | null;
}

/** Overflow batches kept for the timing effect — far more than renders between two commits. */
const OVERFLOW_BATCHES = 8;

type Observation = PageObservation<RowEntry, ResourceError>;

/**
 * Read a `scroll: true` collection — or a paged value — as live key-range
 * pages kept live by a viewport — `useLive(source, query, { viewport,
 * resetKey? })`. `query` is a collection's filter and order, a value's
 * question (`null` = nothing to read yet: loading, nothing read); the read
 * starts at one step (`default.limit`, `paged.limit`) and pages through
 * `loadMore()`, with no depth limit. The pages near `viewport` are subscribed, so a row that stops
 * matching leaves and a new one enters wherever it falls on screen; a page
 * scrolled away keeps the rows it held until it comes back.
 *
 * The result is `loading` (or `error`, when the first page failed) until the
 * first page settles; after that it is `ready` and never flips back — a
 * split or merge hands each new page the rows of the one it replaces until
 * its own read lands, and a page whose read fails keeps its rows with a
 * `pageErrors` entry to retry.
 */
export function useViewportPages<Row, F, S extends string, Meta, Q, QIn>(
  source:
    | LiveScrollCollection<Row, F, S>
    | LivePagedValue<Row, Meta, Q, QIn, LiveValueOrigin>
    | null,
  query: LivePagesQuery<F, S> | null,
  options: LivePagesOptions,
): LivePagesResult<Row> {
  if (source === null && query !== null) {
    throw new Error(
      "useLive(null, query, { viewport }): a query with no source — pass null for both to read nothing.",
    );
  }
  return usePages(
    // Either kind: `pageSourceOf` dispatches on the declaration itself, and
    // the overloads have already paired each with its own query type.
    pageSourceOf(source as LiveScrollCollection<Row, F, S> | null),
    query,
    {
      viewport: options.viewport,
      resetKey: options.resetKey,
      step: undefined,
    },
  ).pages;
}

/**
 * A plain window read of a `scroll: true` collection — `useLive(c, query?)`
 * with no viewport — as key-range pages, every one live: the first page is
 * the window tuple a plain read always subscribed (`query.limit`, else the
 * default — so the boot snapshot's tuple still hydrates it), `loadMore()`
 * splits the last page instead of reloading a larger window, and the read is
 * capped: it never pages past `maxLimit` rows, and drops the pages a live
 * insert pushes beyond them (`everyPageLive`). Its result is the plain list result
 * (`LiveListResult`): `loading`, `ready` with `canGrow` / `growing` /
 * `loadMore`, or `error` — the head's failure, or a page's under the rows
 * still shown (`stale`).
 */
export function useAllPages<Row, F, S extends string>(
  collection: LiveScrollCollection<Row, F, S>,
  query: LiveQuery<F, S> | undefined,
): PagedResourceResult<Row> {
  const { limit, ...rest } = query ?? {};
  const read = usePages(pageSourceOf(collection), rest, {
    viewport: null,
    resetKey: undefined,
    step: limit,
  });
  return useMemo(() => listResultOf(read), [read]);
}

/** `useLive(pagedValue, query, options?)` — a paged value read with no viewport. */
export interface LiveValuePagesOptions {
  /**
   * Page 0's limit and the step a `loadMore()` grows by — a preview — in
   * `1..paged.maxLimit`. Default `paged.limit`.
   */
  limit?: number;
  viewport?: never;
}

/**
 * A plain read of a paged value — `useLive(v, query | null, { limit? })` with
 * no viewport — as key-range pages, every one live: page 0 is `{ q, limit }`,
 * `loadMore()` splits the last page, and the read never pages past
 * `paged.maxLimit` items. Its result is the plain list result, as a scroll
 * collection's plain read: a page's failure under the items shown is the
 * `error` arm with them as `stale`.
 */
export function useValuePages<Item, Meta, Q, QIn>(
  value: LivePagedValue<Item, Meta, Q, QIn, LiveValueOrigin>,
  query: QIn | null,
  options: LiveValuePagesOptions | undefined,
): PagedResourceResult<Item> {
  const limit = options?.limit;
  const { maxLimit } = value.paged;
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > maxLimit)
  ) {
    throw new Error(
      `useLive("${value.key}", query, { limit: ${limit} }): the limit is not an integer in 1..${maxLimit}`,
    );
  }
  const read = usePages(pageSourceOf(value), query, {
    viewport: null,
    resetKey: undefined,
    step: limit,
  });
  return useMemo(() => listResultOf(read), [read]);
}

/** A paged read with no viewport, as the plain list result. */
function listResultOf<Row>(read: PagesRead<Row>): PagedResourceResult<Row> {
  const { pages, refetch } = read;
  switch (pages.status) {
    case "loading":
      return { status: "loading", refetch };
    case "error":
      return { status: "error", error: pages.error, refetch: pages.refetch };
    case "ready": {
      // `assemble` builds the rows afresh: the list is the read's own array.
      const data = pages.rows as Row[];
      const failed = pages.pageErrors[0];
      if (failed !== undefined) {
        return { status: "error", error: failed.error, stale: data, refetch };
      }
      return {
        status: "ready",
        data,
        refetch,
        canGrow: pages.canGrow,
        growing: pages.growing,
        loadMore: pages.loadMore,
      };
    }
  }
}

/** A paged read and a re-read of every page it reads. */
interface PagesRead<Row> {
  pages: LivePagesResult<Row>;
  refetch: () => Promise<void>;
}

/** How `usePages` reads: by a viewport or by none, from which first page. */
interface PagesReadOptions {
  /** `null`: no viewport — every page live, capped at `maxLimit` rows. */
  viewport: VisibleRange | null;
  resetKey: string | undefined;
  /** Page 0's limit and the step a page grows by; absent: the source's. */
  step: number | undefined;
}

/** The paged read over any page source; a `null` query reads nothing. */
function usePages<Row, Q, P extends Record<string, string>>(
  source: PageSource<Row, Q, P>,
  query: Q | null,
  options: PagesReadOptions,
): PagesRead<Row> {
  const { viewport } = options;
  const step = options.step ?? source.limits.step;
  const limits: PageLimits = useMemo(
    () => ({
      step,
      maxLimit: source.limits.maxLimit,
      staleRows: STALE_STEPS * step,
    }),
    [source, step],
  );
  // With no viewport every page is live, so the read is capped: a new page
  // must fit under `maxLimit` rows.
  const capped = viewport === null;
  // The query's canonical key (the source's `base`, and the step its pages
  // are cut at). A collection's leaves out the column sets a query brings, so
  // a change of them alone keeps the plan, its cuts and its rows (the plan
  // reads the new query from then on).
  const base =
    query === null ? null : JSON.stringify([source.base(query), step]);
  const resetKey = JSON.stringify([source.key, options.resetKey ?? base]);

  const [hook, setHook] = useState<HookState<Q>>(() => ({
    resetKey,
    current:
      query === null
        ? null
        : {
            base: base!,
            query,
            state: startPages<RowEntry>(limits),
          },
    previous: null,
    collapse: null,
    overflowed: null,
  }));

  // A new query: a fresh plan — keeping the previous rows on screen when only
  // what `resetKey` leaves out changed (adjusting state during render, the
  // React pattern for state derived from a changed prop).
  let state = hook;
  if ((state.current?.base ?? null) !== base) {
    const keep =
      state.current !== null && base !== null && state.resetKey === resetKey;
    // Back to the query still on screen (a search typed, then undone before
    // its head settled): that plan is current again, nothing restarts.
    const restored =
      keep && state.previous !== null && state.previous.base === base
        ? state.previous
        : null;
    state = {
      resetKey,
      current:
        restored ??
        (query === null
          ? null
          : {
              base: base!,
              query,
              state: startPages<RowEntry>(limits),
            }),
      previous:
        keep && restored === null ? (state.previous ?? state.current) : null,
      collapse: state.collapse,
      overflowed: state.overflowed,
    };
  } else if (
    state.current !== null &&
    query !== null &&
    !sameColumns(source.columnsOf(state.current.query), source.columnsOf(query))
  ) {
    state = {
      ...state,
      current: { ...state.current, query },
    };
  }
  // What this render reads: the plans as they stand before the reconcile
  // below (which may change the pages the next render reads).
  const readState = state;

  // Every live page either plan reads, one window tuple per page — each
  // encoded once per plan state (not per lookup), and each read once however
  // many pages name it. A page a split or merge minted carries its seed: the
  // slices of the pages it replaces that are its whole range, so its first
  // sub may be answered from rows this tab holds (live-state's derivation —
  // `loadMore` then reads only the new page's rows, a merge reads nothing).
  const { current: readCurrent, previous: readPrevious } = readState;
  const reads = useMemo(() => {
    const plans = [readCurrent, readPrevious].filter(
      (p): p is Plan<Q> => p !== null,
    );
    const paramsOf = (plan: Plan<Q>, page: Page): P =>
      source.params(plan.query, page);
    /** `pageKeyOf(plan, page)` → its tuple's key. */
    const tupleKeyOf = new Map<string, string>();
    const tuples = new Map<
      string,
      {
        params: P;
        derive: ResourceDerivation<P> | null;
      }
    >();
    for (const plan of plans) {
      for (const { page, live, seed } of plan.state.pages) {
        if (!live) continue;
        const pk = pageKeyOf(plan, page);
        if (tupleKeyOf.has(pk)) continue;
        const params = paramsOf(plan, page);
        const tk = JSON.stringify(params);
        tupleKeyOf.set(pk, tk);
        tuples.set(tk, {
          params,
          derive:
            seed === null
              ? null
              : {
                  from: seed.from.map((s) => ({
                    params: paramsOf(plan, s.page),
                    appliedSeq: s.appliedSeq,
                    after: s.after,
                    until: s.until,
                  })),
                },
        });
      }
    }
    const list = [...tuples.values()];
    return {
      tupleKeyOf,
      keys: [...tuples.keys()],
      params: list.map((t) => t.params),
      derive: list.map((t) => t.derive),
    };
  }, [readCurrent, readPrevious, source]);
  const results = useResources(source.descriptor, reads.params, {
    release: "now",
    derive: reads.derive,
  });

  // Each tuple's result and what the plan observes of it, by tuple.
  const byTuple = useMemo(() => {
    const map = new Map<
      string,
      { result: ResourceTupleResult<Row[]>; obs: Observation }
    >();
    reads.keys.forEach((tk, i) => {
      const result = results[i]!;
      const rows = rowsOfResult(result);
      const obs: Observation =
        rows === undefined
          ? result.status === "error"
            ? { kind: "failed", error: result.error }
            : { kind: "pending" }
          : {
              kind: "settled",
              entries: rows.map((row) => entryOf(row, source.idField)),
              error: result.status === "error" ? result.error : null,
              appliedSeq: result.appliedSeq,
            };
      map.set(tk, { result, obs });
    });
    return map;
  }, [reads, results, source]);
  /** A page's read — `null` for a page this render does not read (minted or made live since). */
  const read = useCallback(
    (plan: Plan<Q>, page: Page) => {
      const tk = reads.tupleKeyOf.get(pageKeyOf(plan, page));
      const hit = tk === undefined ? undefined : byTuple.get(tk);
      return hit === undefined || tk === undefined
        ? null
        : { ...hit, tupleKey: tk };
    },
    [reads, byTuple],
  );
  const observeIn = useCallback(
    (plan: Plan<Q>) =>
      (page: Page): Observation =>
        read(plan, page)?.obs ?? PENDING,
    [read],
  );

  // Advance the plan (structural steps, then the viewport's live set), and
  // retire the previous rows once the current head has an answer.
  if (state.current !== null) {
    const plan = state.current;
    const outcome = reconcile(plan.state, observeIn(plan), viewport, limits);
    if (outcome.plan !== plan.state) {
      state = {
        ...state,
        current: { ...plan, state: outcome.plan },
        ...(outcome.collapsed
          ? {
              collapse: {
                seq: (state.collapse?.seq ?? 0) + 1,
                ...outcome.collapsed,
              },
            }
          : {}),
        ...(outcome.overflowed
          ? {
              overflowed: {
                seq: (state.overflowed?.seq ?? 0) + 1,
                batches: [
                  ...(state.overflowed?.batches.slice(1 - OVERFLOW_BATCHES) ??
                    []),
                  {
                    seq: (state.overflowed?.seq ?? 0) + 1,
                    base: plan.base,
                    pages: outcome.overflowed,
                  },
                ],
              },
            }
          : {}),
      };
    }
    if (state.previous !== null) {
      const head = assemble(plan.state, observeIn(plan));
      if (head.loaded || head.headError !== null) {
        state = { ...state, previous: null };
      }
    }
  }
  if (state !== hook) setHook(state);

  // A full page that could not split is reported loudly, once.
  const collapse = readState.collapse;
  useEffect(() => {
    if (collapse === null) return;
    clientLog(
      "live-pages",
      `[${source.key}] page ${collapse.at} could not split (${collapse.reason}) — collapsed the pages after it into it`,
    );
  }, [collapse, source]);

  // What the `live-pages` instrumentation below reads of this render: each
  // LIVE page of the current plan, by its key in the plan, with its tuple and
  // what its read shows (`undefined` while it has nothing). One pass over the
  // pages, no row touched.
  const liveReads = useMemo(() => {
    const plan = readCurrent;
    if (plan === null) return null;
    const out: {
      pageKey: string;
      tupleKey: string;
      rows: readonly unknown[] | undefined;
    }[] = [];
    for (const { page, live } of plan.state.pages) {
      if (!live) continue;
      const hit = read(plan, page);
      if (hit === null) continue;
      out.push({
        pageKey: pageKeyOf(plan, page),
        tupleKey: hit.tupleKey,
        rows: rowsOfResult(hit.result),
      });
    }
    return out;
  }, [readCurrent, read]);

  // How long an overflow split hides rows: a full page that is not last
  // splits at its median, and its rest page `(m, b]` is read whole — until that
  // read first settles, a row past the old page's last is in no page. Timed
  // from the commit that mints the page to the commit its read settles in.
  // (The decision this feeds: a hidden-rows marker, dropped unless the gap is
  // common or over ~150 ms — research/2026-10-12-global-live-paging-followups.md.)
  const overflowed = readState.overflowed;
  const overflowStarts = useRef<Map<string, number>>(new Map());
  const overflowSeen = useRef(0);
  useEffect(() => {
    if (overflowed === null) return;
    const at = performance.now();
    for (const batch of overflowed.batches) {
      if (batch.seq <= overflowSeen.current) continue;
      for (const page of batch.pages) {
        const key = planPageKey(batch.base, page);
        if (!overflowStarts.current.has(key)) {
          overflowStarts.current.set(key, at);
        }
      }
    }
    overflowSeen.current = overflowed.seq;
  }, [overflowed]);
  useEffect(() => {
    const starts = overflowStarts.current;
    if (starts.size === 0) return;
    const at = performance.now();
    for (const [key, minted] of starts) {
      // A rest page stays live until its read answers, so one not live is
      // gone before it settled (a new query, a drop past `maxLimit`): no gap
      // left to time.
      const live = liveReads?.find((r) => r.pageKey === key);
      if (live === undefined) {
        starts.delete(key);
        continue;
      }
      if (live.rows === undefined) continue;
      starts.delete(key);
      clientLog(
        "live-pages",
        `[${source.key}] overflow-split gap ${Math.round(at - minted)}ms (rest page settled with ${live.rows.length} rows)`,
      );
    }
  }, [liveReads, source]);

  // A row moving between two live pages arrives as two frames; when the one
  // it leaves lands first, the row is in no page until the other does. Logged
  // per gap closed within 1 s (a delete never comes back, so it is none) — the
  // decision this feeds: a client-side departure hold in the plan, built only
  // if it fires. Diffed per CHANGED page (`cross-page-gaps.ts`).
  const gaps = useRef<{
    source: PageSource<Row, Q, P>;
    detector: CrossPageGaps<unknown>;
  } | null>(null);
  useEffect(() => {
    if (liveReads === null) return;
    if (gaps.current?.source !== source) {
      gaps.current = {
        source,
        detector: createCrossPageGaps<unknown>(
          (row) => entryOf(row, source.idField).id,
        ),
      };
    }
    const pages: GapPage<unknown>[] = [];
    for (const { tupleKey, rows } of liveReads) {
      if (rows !== undefined) pages.push({ key: tupleKey, rows });
    }
    for (const g of gaps.current.detector.observe(performance.now(), pages)) {
      clientLog(
        "live-pages",
        `[${source.key}] cross-page gap: row ${g.id} was in no live page for ${Math.round(g.ms)}ms`,
      );
    }
  }, [liveReads, source]);

  // The plan's shape, logged as it changes: how deep the read is, and how
  // much of it is live.
  const shape =
    readCurrent === null
      ? null
      : `pages=${readCurrent.state.pages.length} live=${readCurrent.state.pages.filter((p) => p.live).length}`;
  useEffect(() => {
    if (shape === null) return;
    clientLog("live-pages", `[${source.key}] ${shape}`);
  }, [shape, source]);

  // Pages past the last page of the plan this render read — a no-op if it
  // moved on since.
  const loadMore = useCallback(() => {
    setHook((prev) => {
      if (prev.current === null || prev.current !== readCurrent) return prev;
      const plan = prev.current;
      const observe = observeIn(plan);
      if (
        capped &&
        !fits(assemble(plan.state, observe).entries.length, limits)
      ) {
        return prev;
      }
      const next = loadMorePages(plan.state, observe, limits);
      return next === plan.state
        ? prev
        : { ...prev, current: { ...plan, state: next } };
    });
  }, [readCurrent, observeIn, limits, capped]);

  const result = useMemo((): LivePagesResult<Row> => {
    const plan = readCurrent;
    if (plan === null) return { status: "loading" };
    const own = assemble(plan.state, observeIn(plan));
    const handoff =
      readPrevious !== null && !own.loaded && own.headError === null;
    const shown = handoff ? readPrevious : plan;
    const a = handoff ? assemble(shown.state, observeIn(shown)) : own;
    if (a.headError !== null) {
      const head = read(shown, shown.state.pages[0]!.page)!.result;
      return { status: "error", error: a.headError, refetch: head.refetch };
    }
    if (!a.loaded) return { status: "loading" };
    const rows = a.entries.map((e) => withoutWindowFields(e.row as Row));
    const pageErrors: LivePageError[] = a.failures.map((f) => {
      const before = a.firstOf[f.index]! - 1;
      const { result, tupleKey } = read(shown, f.page)!;
      return {
        key: tupleKey,
        afterRowId: before < 0 ? null : a.entries[before]!.id,
        error: f.error,
        blocksPaging: f.blocksPaging,
        retry: () => void result.refetch(),
      };
    });
    const placeholderOf = (p: PagePlaceholder): LivePagePlaceholder => ({
      key: p.key,
      rows: p.size,
    });
    return {
      status: "ready",
      rows,
      placeholders: {
        before: a.before.map(placeholderOf),
        after: a.after.map(placeholderOf),
      },
      exhausted: !handoff && a.exhausted,
      canGrow: !handoff && a.canGrow && (!capped || fits(rows.length, limits)),
      growing: !handoff && a.growing,
      loadMore,
      truncated:
        !handoff && a.truncated !== null ? { reason: a.truncated } : false,
      pageErrors,
    };
  }, [readCurrent, readPrevious, read, observeIn, loadMore, capped, limits]);

  // A last page that cannot be paged past, in the plan's own terms (the
  // surface tells the user in theirs), logged once each time the read
  // reaches it.
  const truncatedAt =
    result.status === "ready" && result.truncated !== false
      ? result.truncated.reason
      : null;
  useEffect(() => {
    if (truncatedAt === null) return;
    clientLog(
      "live-pages",
      `[${source.key}] the read stops short: ${TRUNCATION_DETAIL[truncatedAt]}`,
    );
  }, [truncatedAt, source]);

  // Re-read every page this render reads (a plain reader's `refetch`).
  const refetch = useCallback(async () => {
    await Promise.all(results.map((r) => r.refetch()));
  }, [results]);
  return useMemo(() => ({ pages: result, refetch }), [result, refetch]);
}

/** A capped read may page once more: the new page's step still fits under `maxLimit`. */
function fits(rows: number, limits: PageLimits): boolean {
  return rows + limits.step <= limits.maxLimit;
}

/**
 * A tuple's rows: its value, or — failed — the last one it held; `undefined`
 * while it has none.
 */
function rowsOfResult<T>(result: ResourceTupleResult<T[]>): T[] | undefined {
  switch (result.status) {
    case "loading":
      return undefined;
    case "error":
      return result.stale;
    case "ready":
      return result.data;
  }
}

/** One plan entry per wire row object, so a held page keeps its rows' identity. */
const entries = new WeakMap<object, RowEntry>();
function entryOf(row: unknown, idField: string): RowEntry {
  const o = row as Record<string, unknown>;
  let e = entries.get(o);
  if (e === undefined) {
    e = {
      id: String(o[idField]),
      key: (o[LIVE_ROW_KEY] as string | null | undefined) ?? null,
      row,
    };
    entries.set(o, e);
  }
  return e;
}

/** The same column sets, by identity — what a query's `columns` change is. */
function sameColumns(
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined,
): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  return (a ?? []).every((x, i) => x === b![i]);
}

/** A page's identity within the plan reading it: its plan's query and its bounds. */
function pageKeyOf(plan: Plan<unknown>, page: Page): string {
  return planPageKey(plan.base, page);
}

/** {@link pageKeyOf} from the plan's `base` alone. */
function planPageKey(base: string, page: Page): string {
  return `${base}\u0000${pageKey(page)}`;
}

const PENDING: Observation = { kind: "pending" };
