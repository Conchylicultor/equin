/**
 * `useLive` over a scroll collection — its key-range pages, with a viewport and
 * without — over a real NotificationsProvider + QueryClient: each page is
 * a window tuple, driven with `client.setQueryData` on the exact tuple its
 * codec encodes (the same call a WS sub-ack makes), and a read failure through
 * the one HTTP path (`fetchOverHttp`), as `use-live.test.tsx` does.
 *
 * - loading until the head settles, then never again; `$key` split off;
 * - a loadMore splits the full last page at its last row: the rows stay on
 *   screen (`growing`) until the new page's read lands;
 * - the split's known half is subscribed SEEDED — its `derive` names the old
 *   last page's rows through the cut — and the new page plainly;
 * - a merge of two pages neither full is subscribed seeded from both, and an
 *   overflow split seeds only its half up to the cut — each seeded sub sent
 *   before the pages it replaces are released (`release: "now"`), so the
 *   server still holds the sources it derives from;
 * - a failing page keeps the rows shown, with its own retry (not loadMore);
 * - pages far from the viewport are unsubscribed at once and keep their rows;
 *   in view again, they are subscribed again;
 * - a query change with the same `resetKey` keeps the previous rows until the
 *   new head settles; any other change starts over, loading;
 * - past the stale budget the farthest pages are placeholders (never rows);
 *   one on screen is subscribed again and replaced by its rows;
 * - a change of the column sets alone keeps the plan, its cuts and its rows;
 * - with no viewport every page is live and the read is the plain list
 *   result: `loadMore` splits, the read caps at `maxLimit` rows (pages an
 *   insert pushes past it go), page 0 is the plain window tuple;
 * - a plain reader shares page 0 with a paged one through the refcount, and
 *   stays ready after the paged one releases it;
 * - `null` ↔ a collection under a viewport keeps the hook order; a call site
 *   that switches between a viewport and none throws;
 * - a boot-hydrated page 0 is ready on the first render, both ways.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { z } from "zod";
import {
  NotificationsProvider,
  getNotificationsClient,
  queryKeyFor,
} from "@plugins/primitives/plugins/live-state/web";
import {
  liveCollection,
  scopedLiveColumns,
  type LiveWindowBounds,
} from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { useLive } from "../internal/use-live";
import type { LivePagesResult } from "../internal/use-pages";
import type { LivePagesQuery } from "../internal/page-source";
import { mintVisibleRange, type VisibleRange } from "../internal/visible-range";

const Row = z.object({ id: z.string(), n: z.number(), title: z.string() });
type Row = z.infer<typeof Row>;

let seq = 0;
function collection() {
  return liveCollection(`test.use-pages.${seq++}`, {
    row: Row,
    id: "id",
    filterable: { title: liveText() },
    sortable: ["n"],
    default: { orderBy: [["n", "asc"]], limit: 2 },
    maxLimit: 4,
    scroll: true,
  });
}
type C = ReturnType<typeof collection>;
type Query = LivePagesQuery<C["filterable"], "n">;

const keyOf = (n: number) => JSON.stringify([String(n), `r${n}`]);
/** Wire rows n ∈ [from, to), each with its server-minted `$key`. */
const wire = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `r${from + i}`,
    n: from + i,
    title: "t",
    $key: keyOf(from + i),
  }));
const rows = (from: number, to: number): Row[] =>
  wire(from, to).map(({ $key: _k, ...r }) => r);

const MEASURING = mintVisibleRange({ kind: "measuring" });
const on = (from: number, to: number): VisibleRange =>
  mintVisibleRange({ kind: "rows", first: `r${from}`, last: `r${to}` });

// ONE client for the file: the NotificationsClient is a tab singleton,
// created against the first provider's client — a released page's cache is
// dropped from that one (every test reads its own collection key).
const CLIENT = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnMount: false, staleTime: Infinity },
  },
});
function makeClient(): QueryClient {
  return CLIENT;
}

function tuple(
  c: C,
  limit: number,
  bounds: LiveWindowBounds = {},
  query: Query = {},
) {
  return queryKeyFor(
    c.key,
    c.window.window.encode({ ...query, limit }, bounds),
  );
}

interface Props {
  query: Query | null;
  resetKey?: string;
  viewport?: VisibleRange;
}

function mount(client: QueryClient, c: C, initial: Props) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NotificationsProvider queryClient={client}>
      {children}
    </NotificationsProvider>
  );
  const rendered = renderHook(
    (p: Props) =>
      useLive(c, p.query, {
        viewport: p.viewport ?? MEASURING,
        ...(p.resetKey === undefined ? {} : { resetKey: p.resetKey }),
      }),
    { wrapper, initialProps: initial },
  );
  const notifications = getNotificationsClient();
  if (!notifications) throw new Error("NotificationsClient not created");
  vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
  return { ...rendered, notifications };
}

function settled<Row>(
  r: LivePagesResult<Row>,
): Extract<LivePagesResult<Row>, { status: "ready" }> {
  if (r.status !== "ready") throw new Error("expected a settled read");
  return r;
}

/** Page `c` to `pages` pages of two rows each (rows 0 … 2·pages − 1 loaded). */
async function pageTo(
  client: QueryClient,
  c: C,
  result: { current: LivePagesResult<Row> },
  pages: number,
): Promise<void> {
  act(() => {
    client.setQueryData(tuple(c, 2), wire(0, 2));
  });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  for (let p = 1; p < pages; p++) {
    act(() => settled(result.current).loadMore());
    const cut = keyOf(2 * p - 1);
    const prev = p === 1 ? {} : { after: keyOf(2 * p - 3) };
    act(() => {
      client.setQueryData(
        tuple(c, 4, { ...prev, until: cut }),
        wire(2 * p - 2, 2 * p),
      );
      client.setQueryData(tuple(c, 2, { after: cut }), wire(2 * p, 2 * p + 2));
    });
    await waitFor(() =>
      expect(settled(result.current).rows).toHaveLength(2 * p + 2),
    );
  }
}

describe("useLive — a scroll collection's pages, with a viewport", () => {
  it("a null query reads nothing and stays loading", () => {
    const c = collection();
    const client = makeClient();
    const { result } = mount(client, c, { query: null });
    expect(result.current).toEqual({ status: "loading" });
    expect(client.getQueryCache().findAll()).toHaveLength(0);
  });

  it("is loading until the head settles; rows come without their $key", async () => {
    const c = collection();
    const client = makeClient();
    const { result } = mount(client, c, { query: {} });
    expect(result.current.status).toBe("loading");
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = settled(result.current);
    expect(r.rows).toEqual(rows(0, 2));
    expect(r.canGrow).toBe(true);
    expect(r.exhausted).toBe(false);
    expect(r.growing).toBe(false);
  });

  it("a loadMore splits the full last page at its last row, the rows on screen until the new page lands", async () => {
    const c = collection();
    const client = makeClient();
    const { result } = mount(client, c, { query: {} });
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => settled(result.current).loadMore());
    // `(∅, r1] @ 4` (the rows it showed, with headroom) and `(r1, ∞) @ 2`.
    const mid = settled(result.current);
    expect(mid.growing).toBe(true);
    expect(mid.canGrow).toBe(false);
    expect(mid.rows).toEqual(rows(0, 2));
    act(() => {
      client.setQueryData(tuple(c, 4, { until: keyOf(1) }), wire(0, 2));
      client.setQueryData(tuple(c, 2, { after: keyOf(1) }), wire(2, 4));
    });
    await waitFor(() =>
      expect(settled(result.current).rows).toEqual(rows(0, 4)),
    );
    const r = settled(result.current);
    expect(r.growing).toBe(false);
    expect(r.canGrow).toBe(true);
    // The replaced default tuple is released at once, its cached value with it.
    expect(
      client.getQueryCache().find({ queryKey: tuple(c, 2), exact: true }),
    ).toBeUndefined();
  });

  it("a loadMore subscribes the known half seeded from the old last page, and the new page plainly", async () => {
    const c = collection();
    const client = makeClient();
    const { result, notifications } = mount(client, c, { query: {} });
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const observe = vi.spyOn(notifications, "observe");
    act(() => settled(result.current).loadMore());
    const encode = c.window.window.encode;
    const deriveOf = (params: unknown) =>
      observe.mock.calls.find(
        (call) => JSON.stringify(call[1]) === JSON.stringify(params),
      )?.[5];
    expect(deriveOf(encode({ limit: 4 }, { until: keyOf(1) }))).toEqual({
      from: [
        {
          params: encode({ limit: 2 }),
          // Written through the cache here, never applied by a sub: live-state
          // will send this one plain (no socket-built value to slice).
          appliedSeq: 0,
          after: null,
          until: "r1",
        },
      ],
    });
    expect(deriveOf(encode({ limit: 2 }, { after: keyOf(1) }))).toBeUndefined();
  });

  /**
   * The hook's subscribe / release calls from now on, in call order (vitest's
   * global `invocationCallOrder` across both spies), each subscribe with its
   * `derive` and each release with its `release` mode.
   */
  function callLog(notifications: ReturnType<typeof getNotificationsClient>) {
    const observe = vi.spyOn(notifications!, "observe");
    const unobserve = vi.spyOn(notifications!, "unobserve");
    observe.mockClear();
    unobserve.mockClear();
    return () =>
      [
        ...observe.mock.calls.map((call, i) => ({
          op: "observe" as const,
          params: JSON.stringify(call[1]),
          arg: call[5] as unknown,
          order: observe.mock.invocationCallOrder[i]!,
        })),
        ...unobserve.mock.calls.map((call, i) => ({
          op: "unobserve" as const,
          params: JSON.stringify(call[1]),
          arg: call[3] as unknown,
          order: unobserve.mock.invocationCallOrder[i]!,
        })),
      ].sort((x, y) => x.order - y.order);
  }

  it("a merge subscribes the merged page seeded from both pages, before either is released", async () => {
    const c = collection();
    const client = makeClient();
    const { result, notifications } = mount(client, c, { query: {} });
    await pageTo(client, c, result, 2);
    const encode = c.window.window.encode;
    const a = encode({ limit: 4 }, { until: keyOf(1) });
    const b = encode({ limit: 2 }, { after: keyOf(1) });
    const logOf = callLog(notifications);
    // Deletes leave one row in each: two pages holding ≤ step rows between
    // them, neither full — known whole, so merged with no read.
    act(() => {
      client.setQueryData(queryKeyFor(c.key, a), wire(0, 1));
      client.setQueryData(queryKeyFor(c.key, b), wire(2, 3));
    });
    const merged = JSON.stringify(encode({ limit: 4 }));
    await waitFor(() =>
      expect(
        logOf().some((e) => e.op === "observe" && e.params === merged),
      ).toBe(true),
    );
    const log = logOf();
    const sub = log.findIndex((e) => e.op === "observe" && e.params === merged);
    expect(log[sub]!.arg).toEqual({
      from: [
        { params: a, appliedSeq: 0, after: null, until: null },
        { params: b, appliedSeq: 0, after: null, until: null },
      ],
    });
    // The sources go only after the seeded sub is out — released at once
    // (their snapshots are what the server derives from, so the sub must
    // reach it first).
    const releases = log
      .map((e, i) => ({ ...e, i }))
      .filter(
        (e) =>
          e.op === "unobserve" &&
          (e.params === JSON.stringify(a) || e.params === JSON.stringify(b)),
      );
    expect(releases).toHaveLength(2);
    for (const r of releases) {
      expect(r.i).toBeGreaterThan(sub);
      expect(r.arg).toBe("now");
    }
    expect(settled(result.current).rows).toEqual([
      ...rows(0, 1),
      ...rows(2, 3),
    ]);
  });

  it("an overflow split seeds only the half up to its cut; the half past it is read whole", async () => {
    const c = collection();
    const client = makeClient();
    const { result, notifications } = mount(client, c, { query: {} });
    await pageTo(client, c, result, 2);
    const encode = c.window.window.encode;
    const full = encode({ limit: 4 }, { until: keyOf(1) });
    const logOf = callLog(notifications);
    // Inserts fill the head page (not last) to its limit: it may hide rows,
    // so it splits at its median cuttable row, r-1.
    act(() => {
      client.setQueryData(queryKeyFor(c.key, full), wire(-2, 2));
    });
    const head = JSON.stringify(encode({ limit: 4 }, { until: keyOf(-1) }));
    const rest = JSON.stringify(
      encode({ limit: 4 }, { after: keyOf(-1), until: keyOf(1) }),
    );
    await waitFor(() =>
      expect(logOf().some((e) => e.op === "observe" && e.params === rest)).toBe(
        true,
      ),
    );
    const log = logOf();
    const at = (params: string) =>
      log.findIndex((e) => e.op === "observe" && e.params === params);
    expect(log[at(head)]!.arg).toEqual({
      from: [{ params: full, appliedSeq: 0, after: null, until: "r-1" }],
    });
    expect(log[at(rest)]!.arg).toBeUndefined();
    const release = log.findIndex(
      (e) => e.op === "unobserve" && e.params === JSON.stringify(full),
    );
    expect(release).toBeGreaterThan(at(head));
    expect(log[release]!.arg).toBe("now");
  });

  it("a failing new page keeps the rows shown, with its own retry — never loadMore", async () => {
    const c = collection();
    const client = makeClient();
    const { result, notifications } = mount(client, c, { query: {} });
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => settled(result.current).loadMore());
    act(() => {
      client.setQueryData(tuple(c, 4, { until: keyOf(1) }), wire(0, 2));
    });
    const fetch = vi
      .spyOn(notifications, "fetchOverHttp")
      .mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await expect(
        client
          .getQueryCache()
          .find({ queryKey: tuple(c, 2, { after: keyOf(1) }), exact: true })!
          .fetch(),
      ).rejects.toThrow("boom");
    });
    await waitFor(() =>
      expect(settled(result.current).pageErrors).toHaveLength(1),
    );
    const r = settled(result.current);
    expect(r.rows).toEqual(rows(0, 2));
    // No spinner beside the failure: nothing is loading any more.
    expect(r.growing).toBe(false);
    const [failure] = r.pageErrors;
    expect(failure!.blocksPaging).toBe(true);
    expect(failure!.afterRowId).toBe("r1");
    expect(failure!.error.message).toBe("boom");
    expect(failure!.retry).not.toBe(r.loadMore);

    fetch.mockResolvedValueOnce(wire(2, 4));
    await act(async () => {
      failure!.retry();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(settled(result.current).rows).toEqual(rows(0, 4)),
    );
    expect(settled(result.current).pageErrors).toEqual([]);
  });

  it("pages far from the viewport are unsubscribed at once and keep their rows; in view, subscribed again", async () => {
    const c = collection();
    const client = makeClient();
    const { result, rerender, notifications } = mount(client, c, {
      query: {},
    });
    await pageTo(client, c, result, 6);
    const unobserve = vi.spyOn(notifications, "unobserve");
    const observe = vi.spyOn(notifications, "observe");
    const page5 = tuple(c, 2, { after: keyOf(9) });

    // Looking at the head: pages 3 and beyond (3+ away) release, now.
    rerender({ query: {}, viewport: on(0, 1) });
    await waitFor(() => expect(unobserve).toHaveBeenCalled());
    const released = unobserve.mock.calls.map((call) => call[3]);
    expect(released.length).toBeGreaterThan(0);
    expect(released.every((r) => r === "now")).toBe(true);
    expect(
      client.getQueryCache().find({ queryKey: page5, exact: true }),
    ).toBeUndefined();
    // Their rows stay on screen.
    expect(settled(result.current).rows).toEqual(rows(0, 12));
    // Off screen, the last page cannot page.
    expect(settled(result.current).canGrow).toBe(false);

    // Scrolled to the end: the far pages are subscribed again.
    observe.mockClear();
    rerender({ query: {}, viewport: on(10, 11) });
    await waitFor(() =>
      expect(
        client
          .getQueryCache()
          .find({ queryKey: page5, exact: true })
          ?.getObserversCount(),
      ).toBe(1),
    );
    expect(observe).toHaveBeenCalled();
    // Pending again (a released page's cache went with it), showing the rows
    // it held — it pages only once the server vouches for its value.
    expect(settled(result.current).rows).toEqual(rows(0, 12));
    expect(settled(result.current).canGrow).toBe(false);
    act(() => {
      client.setQueryData(page5, wire(10, 12));
    });
    await waitFor(() => expect(settled(result.current).canGrow).toBe(true));
    expect(settled(result.current).rows).toEqual(rows(0, 12));
  });

  it("another collection whose query encodes alike starts over: a plan is one collection's", async () => {
    const a = collection();
    const b = collection();
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NotificationsProvider queryClient={client}>
        {children}
      </NotificationsProvider>
    );
    const { result, rerender } = renderHook(
      (p: { c: C }) =>
        useLive(p.c, {}, { viewport: MEASURING, resetKey: "same" }),
      { wrapper, initialProps: { c: a } },
    );
    await pageTo(client, a, result, 2);
    // Same query, same resetKey — another collection: loading on ITS head,
    // never `a`'s pages read against `b`.
    rerender({ c: b });
    expect(result.current.status).toBe("loading");
    expect(
      client
        .getQueryCache()
        .find({ queryKey: tuple(b, 2, { after: keyOf(1) }), exact: true }),
    ).toBeUndefined();
    act(() => {
      client.setQueryData(tuple(b, 2), wire(7, 9));
    });
    await waitFor(() =>
      expect(settled(result.current).rows).toEqual(rows(7, 9)),
    );
  });

  it("a search undone before its head settles restores the pages still on screen", async () => {
    const c = collection();
    const client = makeClient();
    const { result, rerender } = mount(client, c, {
      query: {},
      resetKey: "sort:n",
    });
    await pageTo(client, c, result, 2);
    rerender({
      query: { where: { title: { contains: "x" } } },
      resetKey: "sort:n",
    });
    expect(settled(result.current).rows).toEqual(rows(0, 4));
    // Typed back: the paged read is current again, not restarted at one page.
    rerender({ query: {}, resetKey: "sort:n" });
    const r = settled(result.current);
    expect(r.rows).toEqual(rows(0, 4));
    expect(r.canGrow).toBe(true);
  });

  it("a query change under the same resetKey keeps the previous rows until the new head settles", async () => {
    const c = collection();
    const client = makeClient();
    const { result, rerender } = mount(client, c, {
      query: {},
      resetKey: "sort:n",
    });
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const searched = { where: { title: { contains: "x" } } } as const;
    rerender({ query: searched, resetKey: "sort:n" });
    const kept = settled(result.current);
    expect(kept.rows).toEqual(rows(0, 2));
    expect(kept.canGrow).toBe(false);

    act(() => {
      client.setQueryData(tuple(c, 2, {}, searched), wire(5, 6));
    });
    await waitFor(() =>
      expect(settled(result.current).rows).toEqual(rows(5, 6)),
    );
    expect(settled(result.current).exhausted).toBe(true);

    // Another reset key: a new read, loading until its head settles.
    rerender({ query: { orderBy: [["n", "desc"]] }, resetKey: "sort:n-desc" });
    expect(result.current.status).toBe("loading");
  });

  it("past the stale budget the farthest pages are placeholders; one on screen is subscribed again and replaced by its rows", async () => {
    const c = collection();
    const client = makeClient();
    const { result, rerender } = mount(client, c, { query: {} });
    // 14 pages of two rows: rows 0 … 27.
    await pageTo(client, c, result, 14);
    const closed = (j: number) =>
      tuple(
        c,
        4,
        j === 0
          ? { until: keyOf(1) }
          : { after: keyOf(2 * j - 1), until: keyOf(2 * j + 1) },
      );
    const observers = (key: unknown[]) =>
      client
        .getQueryCache()
        .find({ queryKey: key, exact: true })
        ?.getObserversCount() ?? 0;

    // Looking at the head: pages 0–2 live, 3–10 hold the budget (16 rows,
    // 8 steps of 2), 11–13 are placeholders of the two rows each held.
    rerender({ query: {}, viewport: on(0, 1) });
    await waitFor(() =>
      expect(settled(result.current).placeholders.after).toHaveLength(3),
    );
    let r = settled(result.current);
    expect(r.placeholders.before).toEqual([]);
    expect(r.placeholders.after.map((p) => p.rows)).toEqual([2, 2, 2]);
    expect(r.rows).toEqual(rows(0, 22));
    expect(r.exhausted).toBe(false);
    const [ph11] = r.placeholders.after;

    // Flung to it: page 11 and its neighbours are subscribed again — still
    // a placeholder until its read lands, never the rows it no longer has.
    rerender({
      query: {},
      viewport: mintVisibleRange({
        kind: "rows",
        first: ph11!.key,
        last: ph11!.key,
      }),
    });
    await waitFor(() => expect(observers(closed(11))).toBe(1));
    expect(observers(closed(12))).toBe(1);
    r = settled(result.current);
    expect(r.placeholders.after.map((p) => p.key)).toContain(ph11!.key);
    expect(r.rows.map((x) => x.id)).not.toContain("r22");
    act(() => {
      client.setQueryData(closed(10), wire(20, 22));
      client.setQueryData(closed(11), wire(22, 24));
      client.setQueryData(closed(12), wire(24, 26));
    });
    // Its rows land in its place; the head, far now, is a placeholder.
    await waitFor(() =>
      expect(settled(result.current).rows.map((x) => x.id)).toContain("r22"),
    );
    r = settled(result.current);
    expect(r.placeholders.after).toHaveLength(1);
    expect(r.placeholders.before.length).toBeGreaterThan(0);
    const before = r.placeholders.before.reduce((n, p) => n + p.rows, 0);
    expect(r.rows).toEqual(rows(before, 26));
  });

  it("a change of the column sets alone keeps the plan, its cuts and its rows", async () => {
    const c = liveCollection(`test.use-pages.${seq++}`, {
      row: Row,
      id: "id",
      filterable: { title: liveText() },
      sortable: ["n"],
      default: { orderBy: [["n", "asc"]], limit: 2 },
      maxLimit: 4,
      scroll: true,
      columnScope: "test.surface",
    });
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NotificationsProvider queryClient={client}>
        {children}
      </NotificationsProvider>
    );
    const one = scopedLiveColumns("test.surface", "custom", {
      a: { domain: "text", sortable: true },
    });
    const two = scopedLiveColumns("test.surface", "custom", {
      a: { domain: "text", sortable: true },
      b: { domain: "number", sortable: true },
    });
    const { result, rerender } = renderHook(
      (p: { columns: typeof one }) =>
        useLive(c, { columns: [p.columns] }, { viewport: MEASURING }),
      { wrapper, initialProps: { columns: one } },
    );
    const notifications = getNotificationsClient()!;
    vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
    act(() => {
      client.setQueryData(queryKeyFor(c.key, { limit: "2" }), wire(0, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => settled(result.current).loadMore());
    act(() => {
      client.setQueryData(
        queryKeyFor(c.key, { limit: "4", until: keyOf(1) }),
        wire(0, 2),
      );
      client.setQueryData(
        queryKeyFor(c.key, { limit: "2", after: keyOf(1) }),
        wire(2, 4),
      );
    });
    await waitFor(() =>
      expect(settled(result.current).rows).toEqual(rows(0, 4)),
    );
    const observe = vi.spyOn(notifications, "observe");
    observe.mockClear();
    // A custom column added to the surface: the same pages, nothing re-read.
    rerender({ columns: two });
    const r = settled(result.current);
    expect(r.rows).toEqual(rows(0, 4));
    expect(r.canGrow).toBe(true);
    expect(observe.mock.calls.filter(([key]) => key === c.key)).toEqual([]);
  });
});

describe("useLive — a scroll collection's pages, without a viewport", () => {
  function mountPlain(client: QueryClient, c: C, query?: { limit: number }) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NotificationsProvider queryClient={client}>
        {children}
      </NotificationsProvider>
    );
    const rendered = renderHook(() => useLive(c, query), { wrapper });
    const notifications = getNotificationsClient()!;
    vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
    return { ...rendered, notifications };
  }
  const ready = <T,>(r: { status: string }) => {
    if (r.status !== "ready")
      throw new Error(`expected ready, got ${r.status}`);
    return r as T;
  };
  type List = {
    data: Row[];
    canGrow: boolean;
    growing: boolean;
    loadMore: () => void;
  };
  const observers = (client: QueryClient, key: unknown[]) =>
    client
      .getQueryCache()
      .find({ queryKey: key, exact: true })
      ?.getObserversCount() ?? 0;

  it("page 0 is the plain window tuple; loadMore splits, every page stays live, capped at maxLimit rows", async () => {
    const c = collection();
    const client = makeClient();
    const { result, notifications } = mountPlain(client, c);
    expect(result.current.status).toBe("loading");
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(ready<List>(result.current).data).toEqual(rows(0, 2));
    expect(ready<List>(result.current).canGrow).toBe(true);

    const unobserve = vi.spyOn(notifications, "unobserve");
    unobserve.mockClear();
    act(() => ready<List>(result.current).loadMore());
    expect(ready<List>(result.current).growing).toBe(true);
    act(() => {
      client.setQueryData(tuple(c, 4, { until: keyOf(1) }), wire(0, 2));
      client.setQueryData(tuple(c, 2, { after: keyOf(1) }), wire(2, 4));
    });
    await waitFor(() =>
      expect(ready<List>(result.current).data).toEqual(rows(0, 4)),
    );
    // Four rows: another page of two would pass maxLimit (4).
    const r = ready<List>(result.current);
    expect(r.canGrow).toBe(false);
    expect(r.growing).toBe(false);
    act(() => r.loadMore());
    expect(ready<List>(result.current).data).toEqual(rows(0, 4));
    // Both pages live: only the split's source was released.
    expect(observers(client, tuple(c, 4, { until: keyOf(1) }))).toBe(1);
    expect(observers(client, tuple(c, 2, { after: keyOf(1) }))).toBe(1);
    expect(
      unobserve.mock.calls
        .filter(([key]) => key === c.key)
        .map((call) => JSON.stringify(call[1])),
    ).toEqual([JSON.stringify(c.window.window.encode({ limit: 2 }))]);
  });

  it("a page an insert pushes past maxLimit rows goes; the page before it becomes the last", async () => {
    const c = collection();
    const client = makeClient();
    const { result } = mountPlain(client, c);
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => ready<List>(result.current).loadMore());
    act(() => {
      client.setQueryData(tuple(c, 4, { until: keyOf(1) }), wire(0, 2));
      client.setQueryData(tuple(c, 2, { after: keyOf(1) }), wire(2, 4));
    });
    await waitFor(() =>
      expect(ready<List>(result.current).data).toEqual(rows(0, 4)),
    );
    // Two rows inserted at the head fill page 0: it splits at r-1, and the
    // pages before the last now hold 4 rows — the cap — so the last goes.
    act(() => {
      client.setQueryData(tuple(c, 4, { until: keyOf(1) }), wire(-2, 2));
    });
    await waitFor(() =>
      expect(observers(client, tuple(c, 2, { after: keyOf(1) }))).toBe(0),
    );
    expect(ready<List>(result.current).data).toEqual(rows(-2, 2));
    const last = tuple(c, 4, { after: keyOf(-1) });
    expect(observers(client, last)).toBe(1);
    act(() => {
      client.setQueryData(tuple(c, 4, { until: keyOf(-1) }), wire(-2, 0));
      client.setQueryData(last, wire(0, 4));
    });
    // The new last page reads up to its own limit past its old cut; the
    // pages before it hold less than the cap, so it stays — and the read,
    // past maxLimit rows now, does not page further.
    await waitFor(() =>
      expect(ready<List>(result.current).data).toEqual(rows(-2, 4)),
    );
    expect(ready<List>(result.current).canGrow).toBe(false);
  });

  it("a query `limit` is page 0's limit — the plain tuple it always read", async () => {
    const c = collection();
    const client = makeClient();
    const { result } = mountPlain(client, c, { limit: 1 });
    act(() => {
      client.setQueryData(tuple(c, 1), wire(0, 1));
    });
    await waitFor(() =>
      expect(ready<List>(result.current).data).toEqual(rows(0, 1)),
    );
    expect(observers(client, tuple(c, 1))).toBe(1);
  });

  it("a plain reader shares page 0 with a paged one and stays ready after the paged one releases it", async () => {
    const c = collection();
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NotificationsProvider queryClient={client}>
        {children}
      </NotificationsProvider>
    );
    const { result } = renderHook(
      () => ({
        plain: useLive(c),
        paged: useLive(c, {}, { viewport: MEASURING }),
      }),
      { wrapper },
    );
    vi.spyOn(getNotificationsClient()!, "hasEverBeenReady").mockReturnValue(
      true,
    );
    expect(observers(client, tuple(c, 2))).toBe(2);
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() => expect(result.current.paged.status).toBe("ready"));
    expect(ready<List>(result.current.plain).data).toEqual(rows(0, 2));

    // The paged read splits page 0 away; the plain one still holds it.
    act(() => settled(result.current.paged).loadMore());
    act(() => {
      client.setQueryData(tuple(c, 4, { until: keyOf(1) }), wire(0, 2));
      client.setQueryData(tuple(c, 2, { after: keyOf(1) }), wire(2, 4));
    });
    await waitFor(() =>
      expect(settled(result.current.paged).rows).toEqual(rows(0, 4)),
    );
    expect(observers(client, tuple(c, 2))).toBe(1);
    expect(ready<List>(result.current.plain).data).toEqual(rows(0, 2));
  });

  it("a boot-hydrated page 0 is ready on the first render, with a viewport and without", () => {
    const c = collection();
    const client = makeClient();
    client.setQueryData(tuple(c, 2), wire(0, 2));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NotificationsProvider queryClient={client}>
        {children}
      </NotificationsProvider>
    );
    const { result } = renderHook(
      () => ({
        plain: useLive(c),
        paged: useLive(c, {}, { viewport: MEASURING }),
      }),
      { wrapper },
    );
    expect(ready<List>(result.current.plain).data).toEqual(rows(0, 2));
    expect(settled(result.current.paged).rows).toEqual(rows(0, 2));
  });
});

describe("useLive — one call site, one kind of read", () => {
  const wrapperOf =
    (client: QueryClient) =>
    ({ children }: { children: ReactNode }) => (
      <NotificationsProvider queryClient={client}>
        {children}
      </NotificationsProvider>
    );

  it("a null collection under a viewport reads nothing, and back, keeping the hook order", async () => {
    const c = collection();
    const client = makeClient();
    const { result, rerender } = renderHook(
      (p: { c: C | null }) =>
        useLive(p.c, p.c === null ? null : {}, { viewport: MEASURING }),
      { wrapper: wrapperOf(client), initialProps: { c: null as C | null } },
    );
    expect(result.current).toEqual({ status: "loading" });
    rerender({ c });
    act(() => {
      client.setQueryData(tuple(c, 2), wire(0, 2));
    });
    await waitFor(() =>
      expect(settled(result.current).rows).toEqual(rows(0, 2)),
    );
    rerender({ c: null });
    expect(result.current).toEqual({ status: "loading" });
  });

  it("a call site that switches between a viewport and none throws", () => {
    const c = collection();
    const client = makeClient();
    // One call site whose options come and go (a cast: no overload takes it).
    const read = useLive as (...args: unknown[]) => unknown;
    const { rerender } = renderHook(
      (p: { paged: boolean }) =>
        read(c, {}, p.paged ? { viewport: MEASURING } : undefined),
      { wrapper: wrapperOf(client), initialProps: { paged: true } },
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => rerender({ paged: false })).toThrow(
      /read a paged read kept live by a viewport, and now asks a window read/,
    );
    error.mockRestore();
  });
});
