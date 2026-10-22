/**
 * `useLive(all[, { select }])` / `useLiveRow(all, id)` over a
 * `createLiveStateHarness` (the use-live.test.tsx harness). A push
 * is the client's own write: a full value is `setQueryData` on the param-less
 * tuple (what a sub-ack does), a delta is `mergeKeyedDelta` over the cached
 * rows then `setQueryData` of its result (exactly `applyDelta`).
 *
 * Pinned (P8 v3 C17, C39):
 *   - a boot-hydrated read renders ONCE, ready, with no loader round-trip —
 *     plain and with a select;
 *   - `data` keeps its identity while nothing is pushed;
 *   - a delta keeps every untouched row's identity;
 *   - every plain observer holds the CACHED array and row objects (no
 *     per-observer select copy), and a push that changes nothing re-renders
 *     no plain read;
 *   - a push that leaves a select's slice alone does not re-render it;
 *   - an `order` delta reorders, and every row keeps its identity — a moved
 *     one included (the cache's structural sharing keeps a reference the
 *     previous array already held);
 *   - id reads go to `:rows`, never to the whole set;
 *   - a scoped set (`all: { by }`) is read one scope at a time: its `where`
 *     record IS the tuple, each scope its own cache entry, and a read
 *     without one (or a `where` on a set declared without `by`) throws.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import type { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  NotificationsProvider,
  ensureNotificationsClient,
  hydrateResource,
  queryKeyFor,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  mergeKeyedDelta,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  testTransport,
  transportWrapper,
} from "@plugins/primitives/plugins/networking/web/testing";

/** The page's transport, whose pipeline is the boot-hoisted one `hydrateResource` seeds. */
const page = testTransport();
const PageTransport = transportWrapper(page);

/** The app's root mount: the page's transport, then its `NotificationsProvider`. */
function PagePipeline({ children }: { children: ReactNode }) {
  return (
    <PageTransport>
      <NotificationsProvider>{children}</NotificationsProvider>
    </PageTransport>
  );
}

const ROW_FIELDS = {
  id: textField({ label: "Id" }),
  title: textField({ label: "Title" }),
  rank: intField({ label: "Rank" }),
};
const Row = fieldsToZodObject(ROW_FIELDS);
type Row = z.infer<typeof Row>;

let seq = 0;
function allCollection() {
  return liveCollection(`test.use-live-all.${seq++}`, {
    fields: ROW_FIELDS,
    id: "id",
    all: { orderBy: [["rank", "asc"]], unbounded: { reason: "a test set" } },
  });
}

const ROWS: Row[] = [
  { id: "a", title: "A", rank: 1 },
  { id: "b", title: "B", rank: 2 },
  { id: "c", title: "C", rank: 3 },
];

/**
 * Mount with a render log under `wrapper`: a harness's own pair, or the app's
 * root mount (`PagePipeline`: the page transport's boot-hoisted pipeline over
 * the default client — the one `hydrateResource` seeds).
 */
function mount<R>(
  wrapper: (props: { children: ReactNode }) => ReactElement,
  useHook: () => R,
) {
  const renders: R[] = [];
  const rendered = renderHook(
    () => {
      const r = useHook();
      renders.push(r);
      return r;
    },
    { wrapper },
  );
  return { ...rendered, renders };
}

/** Let React Query's batched notifications run, so a missing re-render shows. */
async function settleNotifications(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** Apply a keyed delta to the cached tuple the way the client's `applyDelta` does. */
function pushDelta(
  client: QueryClient,
  key: string,
  upserts: Row[],
  order?: string[],
): void {
  const queryKey = queryKeyFor(key, undefined);
  const prev = client.getQueryData<Row[]>(queryKey);
  if (prev === undefined) throw new Error("no cached base to apply a delta to");
  const merged = mergeKeyedDelta(
    prev,
    new Map(upserts.map((r) => [r.id, r])),
    order,
    (row) => (row as Row).id,
  );
  if (merged.kind !== "merged") throw new Error("delta drifted");
  act(() => {
    client.setQueryData(queryKey, merged.rows);
  });
}

function readyData<T>(r: ResourceResult<T>): T {
  if (r.status !== "ready") throw new Error(`expected ready, got ${r.status}`);
  return r.data;
}

const titleOfA = (rows: Row[]): string | undefined =>
  rows.find((r) => r.id === "a")?.title;

describe("useLive(all)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a boot-hydrated read renders once, ready, with no loader round-trip (C39)", async () => {
    const plain = allCollection();
    const selected = allCollection();
    // The boot snapshot's write: `hydrateResource` on the app's default
    // client, at the param-less tuple (an `all` descriptor has no
    // `defaultParams`).
    hydrateResource(plain.all, undefined, ROWS);
    hydrateResource(selected.all, undefined, ROWS);
    const notifications = ensureNotificationsClient(page);
    const fetchOverHttp = vi.spyOn(notifications, "fetchOverHttp");
    const primeFromHttp = vi.spyOn(notifications, "primeFromHttp");
    const observe = vi.spyOn(notifications, "observe");

    const p = mount(PagePipeline, () => useLive(plain));
    const s = mount(PagePipeline, () =>
      useLive(selected, { select: titleOfA }),
    );
    await settleNotifications();

    expect(p.renders).toHaveLength(1);
    expect(readyData(p.renders[0]!)).toEqual(ROWS);
    expect(s.renders).toHaveLength(1);
    expect(readyData(s.renders[0]!)).toBe("A");
    expect(fetchOverHttp).not.toHaveBeenCalled();
    expect(primeFromHttp).not.toHaveBeenCalled();
    // Still subscribed, on the param-less tuple — that is how pushes reach it.
    expect(
      observe.mock.calls
        .filter(([key]) => key === plain.key || key === selected.key)
        .map(([key, params]) => [key, params]),
    ).toEqual([
      [plain.key, {}],
      [selected.key, {}],
    ]);
  });

  it("is loading until its first value, then ready with the rows as cached", async () => {
    const c = allCollection();
    const live = createLiveStateHarness();
    const { result } = mount(live.Wrapper, () => useLive(c));
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(c.key, undefined), ROWS);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(readyData(result.current)).toBe(
      live.queryClient.getQueryData(queryKeyFor(c.key, undefined)),
    );
  });

  it("keeps `data` (and the result) identical while nothing is pushed", async () => {
    const c = allCollection();
    const other = allCollection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, undefined), ROWS);
    live.queryClient.setQueryData(queryKeyFor(other.key, undefined), ROWS);
    const { result, rerender } = mount(live.Wrapper, () => useLive(c));
    const first = result.current;
    const rows = readyData(first);
    rerender();
    // A push to ANOTHER key is no push to this one.
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(other.key, undefined), [
        ROWS[0]!,
      ]);
    });
    await settleNotifications();
    expect(result.current).toBe(first);
    expect(readyData(result.current)).toBe(rows);
  });

  it("a delta keeps every untouched row's identity", async () => {
    const c = allCollection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, undefined), ROWS);
    const { result } = mount(live.Wrapper, () => useLive(c));
    const before = readyData(result.current);

    pushDelta(live.queryClient, c.key, [{ id: "b", title: "B2", rank: 2 }]);
    await waitFor(() => expect(readyData(result.current)[1]!.title).toBe("B2"));
    const after = readyData(result.current);
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("a push that leaves the selected slice alone does not re-render a select; one that moves it does", async () => {
    const c = allCollection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, undefined), ROWS);
    const { result, renders } = mount(live.Wrapper, () =>
      useLive(c, { select: titleOfA }),
    );
    await settleNotifications();
    expect(readyData(result.current)).toBe("A");
    const settled = renders.length;

    pushDelta(live.queryClient, c.key, [{ id: "b", title: "B2", rank: 2 }]);
    pushDelta(live.queryClient, c.key, [], ["c", "b", "a"]);
    await settleNotifications();
    expect(renders).toHaveLength(settled);

    pushDelta(live.queryClient, c.key, [{ id: "a", title: "A2", rank: 1 }]);
    await waitFor(() => expect(readyData(result.current)).toBe("A2"));
  });

  it("an `order` delta reorders; a row left in place keeps its identity", async () => {
    const c = allCollection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, undefined), ROWS);
    const { result } = mount(live.Wrapper, () => useLive(c));
    const before = readyData(result.current);

    pushDelta(live.queryClient, c.key, [], ["b", "a", "c"]);
    await waitFor(() =>
      expect(readyData(result.current).map((r) => r.id)).toEqual([
        "b",
        "a",
        "c",
      ]),
    );
    const after = readyData(result.current);
    expect(after).toEqual([ROWS[1], ROWS[0], ROWS[2]]);
    expect(after[2]).toBe(before[2]);
    // The two rows that swapped are the same objects, moved.
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
  });

  it("every plain observer holds the cached array and rows; a push that changes nothing re-renders none", async () => {
    const c = allCollection();
    const live = createLiveStateHarness();
    const queryKey = queryKeyFor(c.key, undefined);
    live.queryClient.setQueryData(queryKey, ROWS);
    const first = mount(live.Wrapper, () => useLive(c));
    const second = mount(live.Wrapper, () => useLive(c));
    await settleNotifications();

    pushDelta(live.queryClient, c.key, [{ id: "b", title: "B2", rank: 2 }]);
    await waitFor(() =>
      expect(readyData(second.result.current)[1]!.title).toBe("B2"),
    );
    const cached = live.queryClient.getQueryData<Row[]>(queryKey)!;
    for (const observer of [first, second]) {
      const rows = readyData(observer.result.current);
      expect(rows).toBe(cached);
      expect(rows[1]).toBe(cached[1]);
    }

    // A full value equal to the cached one (a resync re-sending the set):
    // the cache keeps its array, so no plain read re-renders.
    const settled = [first.renders.length, second.renders.length];
    act(() => {
      live.queryClient.setQueryData(
        queryKey,
        cached.map((r) => ({ ...r })),
      );
    });
    await settleNotifications();
    expect([first.renders.length, second.renders.length]).toEqual(settled);
    expect(readyData(first.result.current)).toBe(cached);
  });

  it("an id read goes to `:rows`, not to the whole set — useLive(all, { ids }) and useLiveRow(all, id)", async () => {
    const c = allCollection();
    const live = createLiveStateHarness();
    const rowsKey = (ids: string) => queryKeyFor(c.rows.key, { ids });
    live.queryClient.setQueryData(rowsKey("a,b"), [ROWS[0]!, ROWS[1]!]);
    live.queryClient.setQueryData(rowsKey("c"), [ROWS[2]!]);
    const { result } = mount(live.Wrapper, () => ({
      ids: useLive(c, { ids: ["b", "a"] }),
      row: useLiveRow(c, "c"),
    }));
    await waitFor(() => expect(result.current.row.status).toBe("ready"));
    expect(readyData(result.current.ids)).toEqual([ROWS[0], ROWS[1]]);
    const row = result.current.row;
    if (row.status !== "ready" || !row.found) throw new Error("unreachable");
    expect(row.row).toEqual(ROWS[2]);
    // The whole set was never read.
    expect(
      live.queryClient.getQueryState(queryKeyFor(c.key, undefined)),
    ).toBeUndefined();
  });

  it("types: the whole set and a select are `all`-only; a lookup or window collection has no whole set", () => {
    const c = allCollection();
    const lookup = liveCollection(`test.use-live-all.lookup.${seq++}`, {
      fields: ROW_FIELDS,
      id: "id",
    });
    // Never called — the assertions are the types and `@ts-expect-error`s.
    const useTypeOnly = () => {
      const whole: ResourceResult<Row[]> = useLive(c);
      const slice: ResourceResult<string | undefined> = useLive(c, {
        select: titleOfA,
      });
      const opts = { select: titleOfA };
      // @ts-expect-error — a select's result is its slice, not the rows
      const wrong: ResourceResult<Row[]> = useLive(c, opts);
      // @ts-expect-error — a lookup-only collection has no whole set
      useLive(lookup);
      // @ts-expect-error — nor a select over one
      useLive(lookup, { select: titleOfA });
      // @ts-expect-error — an `all` collection has no window to query
      useLive(c, { limit: 3 });
      return [whole, slice, wrong];
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});

describe("useLive(scoped, { where }) — a set declared `all: { by }`", () => {
  afterEach(() => vi.restoreAllMocks());

  const SCOPED_FIELDS = { ...ROW_FIELDS, pageId: textField({ label: "Page" }) };
  type ScopedRow = Row & { pageId: string };
  function scopedCollection() {
    return liveCollection(`test.use-live-all.scoped.${seq++}`, {
      fields: SCOPED_FIELDS,
      id: "id",
      all: {
        by: ["pageId"],
        orderBy: [["rank", "asc"]],
        unbounded: { reason: "one page's rows" },
      },
    });
  }
  const PA: ScopedRow[] = [{ id: "a", title: "A", rank: 1, pageId: "pa" }];
  const PB: ScopedRow[] = [
    { id: "b", title: "B", rank: 1, pageId: "pb" },
    { id: "c", title: "C", rank: 2, pageId: "pb" },
  ];

  it("reads each scope as its own tuple — the `where` record is the params — plain and selected", async () => {
    const c = scopedCollection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, { pageId: "pa" }), PA);
    live.queryClient.setQueryData(queryKeyFor(c.key, { pageId: "pb" }), PB);
    const { result } = mount(live.Wrapper, () => ({
      a: useLive(c, { where: { pageId: "pa" } }),
      b: useLive(c, { where: { pageId: "pb" } }),
      count: useLive(c, {
        where: { pageId: "pb" },
        select: (rows: ScopedRow[]) => rows.length,
      }),
    }));
    await waitFor(() => expect(result.current.count.status).toBe("ready"));
    expect(readyData(result.current.a)).toBe(
      live.queryClient.getQueryData(queryKeyFor(c.key, { pageId: "pa" })),
    );
    expect(readyData(result.current.b)).toEqual(PB);
    expect(readyData(result.current.count)).toBe(2);
    // The param-less tuple was never read.
    expect(
      live.queryClient.getQueryState(queryKeyFor(c.key, undefined)),
    ).toBeUndefined();
  });

  it("an untyped read without a scope, or a scope on a whole set, throws", () => {
    const c = scopedCollection();
    const whole = allCollection();
    const live = createLiveStateHarness();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      mount(live.Wrapper, () => useLive(c as unknown as typeof whole)),
    ).toThrow(
      /declared `all: \{ by \}` — read one scope, `\{ where: \{ pageId \} \}`/,
    );
    expect(() =>
      mount(live.Wrapper, () =>
        useLive(whole as unknown as typeof c, { where: { pageId: "pa" } }),
      ),
    ).toThrow(/`where` on a set declared without `all.by`/);
  });

  it("types: the scope is exactly the `by` fields, each a string; a scoped set has no param-less read", () => {
    const c = scopedCollection();
    const whole = allCollection();
    // Never called — the assertions are the types and `@ts-expect-error`s.
    const useTypeOnly = (pageId: string) => {
      const rows: ResourceResult<ScopedRow[]> = useLive(c, {
        where: { pageId },
      });
      const n: ResourceResult<number> = useLive(c, {
        where: { pageId },
        select: (r) => r.length,
      });
      // @ts-expect-error — a scoped set is read one scope at a time
      useLive(c);
      // @ts-expect-error — nor a select over every scope
      useLive(c, { select: (r: ScopedRow[]) => r.length });
      // @ts-expect-error — the scope's key is missing
      useLive(c, { where: {} });
      // @ts-expect-error — an op or a filter is no scope: the value is the param
      useLive(c, { where: { pageId: { eq: pageId } } });
      // @ts-expect-error — a field outside `by` is no part of the scope
      useLive(c, { where: { pageId, title: "x" } });
      // @ts-expect-error — a whole set has no scope
      useLive(whole, { where: { pageId } });
      // Id reads are global, whatever the scope.
      const byId = useLive(c, { ids: ["a"] });
      const row = useLiveRow(c, "a");
      return [rows, n, byId, row];
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});
