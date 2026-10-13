/**
 * useLive / useLiveRow over `createLiveStateHarness` (a real client and its QueryClient) (the
 * live-state use-resource-error-gate.test.tsx harness): authoritative values
 * are driven with `queryClient.setQueryData` on the exact tuple the codec encodes,
 * the same call a WS sub-ack makes.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { renderHook, waitFor, act } from "@testing-library/react";
import { type ReactNode } from "react";
import { z } from "zod";
import {
  NotificationsProvider,
  hydrateResource,
  pendingMountSnapshot,
  queryKeyFor,
} from "@plugins/primitives/plugins/live-state/web";
import {
  NotificationsClient,
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  liveBoolean,
  liveText,
  or,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  useLive,
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";

const Row = z.object({ id: z.string(), n: z.number(), on: z.boolean() });
type Row = z.infer<typeof Row>;

let seq = 0;
function collection() {
  return liveCollection(`test.use-live.${seq++}`, {
    row: Row,
    id: "id",
    filterable: { on: liveBoolean(), id: liveText() },
    sortable: ["n"],
    default: { orderBy: [["n", "asc"]], limit: 2 },
    maxLimit: 5,
  });
}

const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `r${i}`, n: i, on: true }));

/** A row's server-minted `$key` in the default order (`n`, then the id). */
const keyOf = (i: number) => JSON.stringify([String(i), `r${i}`]);
/**
 * Window rows as the wire carries them, rows [from, to) each with its `$key`
 * — what a page is cut at. Seeded with `setQueryData`, which skips the parse,
 * so a row seeded without one could never be cut.
 */
const keyed = (to: number, from = 0) =>
  rows(to)
    .slice(from)
    .map((r, i) => ({ ...r, $key: keyOf(from + i) }));

function mount<R>(live: LiveStateHarness, useHook: () => R) {
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const rendered = renderHook(useHook, { wrapper: live.Wrapper });
  return { ...rendered, notifications: live.notifications };
}

describe("useLive — window", () => {
  it("the default read subscribes on the declaration's default tuple and reports canGrow on a full window", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, { limit: "2" }), keyed(2));

    const { result } = mount(live, () => useLive(c));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.data).toEqual(rows(2));
    expect(r.canGrow).toBe(true);
    expect(r.growing).toBe(false);
  });

  it("a filtered, sorted query subscribes on its canonical tuple", () => {
    const c = collection();
    const live = createLiveStateHarness();
    mount(live, () =>
      useLive(c, { where: { on: true }, orderBy: [["n", "desc"]], limit: 3 }),
    );
    expect(
      live.queryClient.getQueryState(
        queryKeyFor(c.key, {
          limit: "3",
          order: '[["n","desc"]]',
          where: '{"column":"on","op":"eq","operand":true}',
        }),
      ),
    ).toBeDefined();
  });

  it("an or tree subscribes on its canonical tuple — the same one for any spelling", () => {
    const c = collection();
    const live = createLiveStateHarness();
    mount(live, () =>
      useLive(c, {
        where: or(
          { column: "id", op: "gt", operand: "r3" },
          { column: "on", op: "eq", operand: false },
        ),
      }),
    );
    mount(live, () =>
      useLive(c, {
        where: or(
          { column: "on", op: "eq", operand: false },
          or({ column: "id", op: "gt", operand: "r3" }),
        ),
      }),
    );
    const key = queryKeyFor(c.key, {
      limit: "2",
      where:
        '{"or":[{"column":"id","op":"gt","operand":"r3"},{"column":"on","op":"eq","operand":false}]}',
    });
    expect(live.queryClient.getQueryState(key)).toBeDefined();
    expect(
      live.queryClient
        .getQueryCache()
        .findAll()
        .filter((q) => (q.queryKey as unknown[])[0] === c.key),
    ).toHaveLength(1);
  });

  it("loadMore splits the last page — no reload of a larger window: settled on the rows while the new page loads; canGrow stops a step short of maxLimit", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, { limit: "2" }), keyed(2));

    const { result, notifications } = mount(live, () => useLive(c));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const observe = vi.spyOn(notifications, "observe");
    observe.mockClear();

    act(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error("unreachable");
      r.loadMore();
    });
    // The new page has no value yet: still settled, on the rows it has.
    const mid = result.current;
    if (mid.status !== "ready")
      throw new Error("a split must not flash loading");
    expect(mid.growing).toBe(true);
    expect(mid.data).toEqual(rows(2));
    expect(mid.canGrow).toBe(false);
    // Two pages, cut at the last row: its known half (at twice the step) and
    // the new page past it — never the old window at a larger limit.
    const head = c.window.window.encode({ limit: 4 }, { until: keyOf(1) });
    const next = c.window.window.encode({ limit: 2 }, { after: keyOf(1) });
    const subscribed = observe.mock.calls
      .filter(([key]) => key === c.key)
      .map((call) => JSON.stringify(call[1]));
    expect(subscribed).toEqual(
      expect.arrayContaining([JSON.stringify(head), JSON.stringify(next)]),
    );
    expect(subscribed).not.toContain(JSON.stringify({ limit: "4" }));

    act(() => {
      live.queryClient.setQueryData(queryKeyFor(c.key, head), keyed(2));
      live.queryClient.setQueryData(queryKeyFor(c.key, next), keyed(4, 2));
    });
    await waitFor(() => {
      const r = result.current;
      expect(r.status === "ready" && !r.growing && r.data.length === 4).toBe(
        true,
      );
    });
    const grown = result.current;
    if (grown.status !== "ready") throw new Error("unreachable");
    expect(grown.data).toEqual(rows(4));
    // 4 rows + a page of 2 would pass maxLimit (5): the pager stops here.
    expect(grown.canGrow).toBe(false);
  });

  it("a short window cannot grow", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, { limit: "2" }), keyed(1));
    const { result } = mount(live, () => useLive(c));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.canGrow).toBe(false);
  });
});

// Consumers memoize on a read's result (a Set built from the rows, per row of a
// tree), so a re-render that changes nothing must hand back the same object.
describe("useLive — result identity", () => {
  it("a settled window keeps its result and loadMore across a re-render that changes nothing — inline queries included", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, { limit: "2" }), rows(2));
    live.queryClient.setQueryData(
      queryKeyFor(c.key, {
        limit: "2",
        where: '{"column":"on","op":"eq","operand":true}',
      }),
      rows(2),
    );
    const { result, rerender } = mount(live, () => ({
      all: useLive(c),
      on: useLive(c, { where: { on: true } }),
    }));
    await waitFor(() => {
      expect(result.current.all.status).toBe("ready");
      expect(result.current.on.status).toBe("ready");
    });
    const { all, on } = result.current;
    if (all.status !== "ready" || on.status !== "ready")
      throw new Error("unreachable");

    rerender();
    rerender();
    expect(result.current.all).toBe(all);
    expect(result.current.on).toBe(on);
    const again = result.current.all;
    if (again.status !== "ready") throw new Error("unreachable");
    expect(again.loadMore).toBe(all.loadMore);
  });

  it("a push of deep-equal rows keeps the result; a push that changes them yields a new one", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    const key = queryKeyFor(c.key, { limit: "2" });
    live.queryClient.setQueryData(key, rows(2));
    const { result } = mount(live, () => useLive(c));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current;
    if (first.status !== "ready") throw new Error("unreachable");

    // A fresh array with the same rows: structural sharing keeps `data`.
    act(() => {
      live.queryClient.setQueryData(key, rows(2));
    });
    expect(result.current).toBe(first);

    const changed = [rows(2)[0]!, { id: "r1", n: 1, on: false }];
    act(() => {
      live.queryClient.setQueryData(key, changed);
    });
    await waitFor(() => expect(result.current).not.toBe(first));
    const next = result.current;
    if (next.status !== "ready") throw new Error("unreachable");
    expect(next.data).toEqual(changed);
    expect(next.growing).toBe(false);
    // `loadMore` is the page plan's: a push that changes the rows the plan
    // reads may re-plan, so it is not pinned across one (the result is new
    // anyway); across a push that changes nothing, the result above is kept
    // whole, `loadMore` included.
  });

  it("a split is settled on the rows it has (stable while it loads), then settles on both pages with a new loadMore", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, { limit: "2" }), keyed(2));
    const { result, rerender } = mount(live, () => useLive(c));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current;
    if (first.status !== "ready") throw new Error("unreachable");

    act(() => {
      first.loadMore();
    });
    const mid = result.current;
    if (mid.status !== "ready")
      throw new Error("a split must not flash loading");
    expect(mid.growing).toBe(true);
    expect(mid.data).toEqual(rows(2));
    rerender();
    expect(result.current).toBe(mid);

    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(
          c.key,
          c.window.window.encode({ limit: 4 }, { until: keyOf(1) }),
        ),
        keyed(2),
      );
      live.queryClient.setQueryData(
        queryKeyFor(
          c.key,
          c.window.window.encode({ limit: 2 }, { after: keyOf(1) }),
        ),
        keyed(4, 2),
      );
    });
    await waitFor(() => {
      const r = result.current;
      expect(r.status === "ready" && !r.growing && r.data.length === 4).toBe(
        true,
      );
    });
    const grown = result.current;
    if (grown.status !== "ready") throw new Error("unreachable");
    // The plan moved to two pages, so loadMore is the new plan's.
    expect(grown.loadMore).not.toBe(first.loadMore);
    rerender();
    expect(result.current).toBe(grown);
  });

  it("an id set and a value hand back useResource's result, stable across a re-render", async () => {
    const c = collection();
    const v = liveValue(`test.use-live.value.${seq++}`, {
      schema: z.object({ n: z.number() }),
    });
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(`${c.key}:rows`, { ids: "r0" }),
      rows(1),
    );
    live.queryClient.setQueryData(queryKeyFor(v.key, {}), { n: 1 });
    const { result, rerender } = mount(live, () => ({
      set: useLive(c, { ids: ["r0"] }),
      value: useLive(v),
    }));
    await waitFor(() => {
      expect(result.current.set.status).toBe("ready");
      expect(result.current.value.status).toBe("ready");
    });
    const { set, value } = result.current;
    rerender();
    expect(result.current.set).toBe(set);
    expect(result.current.value).toBe(value);
  });
});

describe("useLive — groupBy", () => {
  const groups = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      value: i % 2 === 0,
      count: count - i,
    }));

  it("subscribes on the :groups tuple and goes loading → settled with paging handles", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    const { result } = mount(live, () =>
      useLive(c, { groupBy: "on", limit: 2 }),
    );
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(`${c.key}:groups`, { groupBy: "on", limit: "2" }),
        groups(2),
      );
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("unreachable");
    // Typed: `on` is a boolean column, so a group's value is boolean | null.
    const value: boolean | null = r.data[0]!.value;
    expect(value).toBe(true);
    expect(r.data).toEqual(groups(2));
    expect(r.canGrow).toBe(true);
    expect(r.growing).toBe(false);
  });

  it("a where rides in the canonical group tuple", () => {
    const c = collection();
    const live = createLiveStateHarness();
    mount(live, () => useLive(c, { groupBy: "on", where: { on: true } }));
    expect(
      live.queryClient.getQueryState(
        queryKeyFor(`${c.key}:groups`, {
          groupBy: "on",
          limit: "50",
          where: '{"column":"on","op":"eq","operand":true}',
        }),
      ),
    ).toBeDefined();
  });

  it("loadMore stays settled on the previous groups while the grown tuple loads", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(`${c.key}:groups`, { groupBy: "on", limit: "2" }),
      groups(2),
    );
    const { result } = mount(live, () =>
      useLive(c, { groupBy: "on", limit: 2 }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error("unreachable");
      r.loadMore();
    });
    const mid = result.current;
    if (mid.status !== "ready") throw new Error("grow must not flash loading");
    expect(mid.growing).toBe(true);
    expect(mid.data).toEqual(groups(2));

    // One default group page (50) past 2, clamped to the group max (100).
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(`${c.key}:groups`, { groupBy: "on", limit: "52" }),
        groups(3),
      );
    });
    await waitFor(() => {
      const r = result.current;
      expect(r.status === "ready" && !r.growing && r.data.length === 3).toBe(
        true,
      );
    });
    const grown = result.current;
    if (grown.status !== "ready") throw new Error("unreachable");
    expect(grown.canGrow).toBe(false); // 3 < 52: every group is loaded
  });

  it("rejects an orderBy and a non-filterable column at the type level", () => {
    const c = collection();
    const live = createLiveStateHarness();
    const ordered = { groupBy: "on", orderBy: [["n", "asc"]] } as const;
    const unfilterable = { groupBy: "n" } as const;
    // @ts-expect-error — a grouping has a fixed order
    const useOrdered = () => useLive(c, ordered);
    // @ts-expect-error — `n` is sortable but not filterable
    const useUnfilterable = () => useLive(c, unfilterable);
    expect(() => mount(live, useOrdered)).toThrow(/fixed order/);
    expect(() => mount(live, useUnfilterable)).toThrow(
      /not a filterable column/,
    );
  });
});

describe("useLive — ids", () => {
  it("an id set reads the :rows sibling on its canonical tuple, with no paging fields", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(`${c.key}:rows`, { ids: "r0,r1" }),
      rows(2),
    );
    const { result } = mount(live, () => useLive(c, { ids: ["r1", "r0"] }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.data).toEqual(rows(2));
    expect("canGrow" in r).toBe(false);
  });
});

describe("useLiveRow", () => {
  it("goes loading → found", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    const { result } = mount(live, () => useLiveRow(c, "r0"));
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(`${c.key}:rows`, { ids: "r0" }),
        rows(1),
      );
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({
      status: "ready",
      found: true,
      row: rows(1)[0],
    });
  });

  it("goes loading → not found when the server answers with no row", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    const { result } = mount(live, () => useLiveRow(c, "nope"));
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(`${c.key}:rows`, { ids: "nope" }),
        [],
      );
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({
      status: "ready",
      found: false,
    });
  });

  it("a null id is not found on the first render, reads nothing, and is not a pending mount", () => {
    const c = collection();
    const live = createLiveStateHarness();
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    // Other suites' mounts may still be counted: measure the difference.
    const before = pendingMountSnapshot().pending;
    const seen: LiveRowResult<Row>[] = [];
    const { unmount } = mount(live, () => {
      const r = useLiveRow(c, null);
      seen.push(r);
      return r;
    });
    expect(seen[0]).toMatchObject({ status: "ready", found: false });
    // The substrate's skip: no subscription at all.
    expect(observe.mock.calls.filter(([key]) => key.startsWith(c.key))).toEqual(
      [],
    );
    observe.mockRestore();
    expect(pendingMountSnapshot().pending).toBe(before);
    for (const r of seen)
      expect(r).toMatchObject({ status: "ready", found: false });
    unmount();
  });

  it.each([
    ["holding a comma", "a,b"],
    ["empty", ""],
  ])(
    "an id the point codec cannot carry (%s) is not found, reads nothing, and does not throw",
    (_label, id) => {
      const c = collection();
      const live = createLiveStateHarness();
      const observe = vi.spyOn(NotificationsClient.prototype, "observe");
      const seen: LiveRowResult<Row>[] = [];
      const { unmount } = mount(live, () => {
        const r = useLiveRow(c, id);
        seen.push(r);
        return r;
      });
      expect(seen.length).toBeGreaterThan(0);
      for (const r of seen)
        expect(r).toMatchObject({ status: "ready", found: false });
      expect(
        observe.mock.calls.filter(([key]) => key.startsWith(c.key)),
      ).toEqual([]);
      observe.mockRestore();
      unmount();
    },
  );

  it("an id switched to null is not found on that very render; switched back, it reads the row", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(`${c.key}:rows`, { ids: "r0" }),
      rows(1),
    );
    let id: string | null = "r0";
    const seen: LiveRowResult<Row>[] = [];
    const { result, rerender } = mount(live, () => {
      const r = useLiveRow(c, id);
      seen.push(r);
      return r;
    });
    const found = {
      status: "ready",
      found: true,
      row: rows(1)[0],
    };
    await waitFor(() => expect(result.current).toMatchObject(found));

    id = null;
    const from = seen.length;
    rerender();
    expect(seen.length).toBeGreaterThan(from);
    for (const r of seen.slice(from)) {
      expect(r).toMatchObject({
        status: "ready",
        found: false,
      });
    }

    id = "r0";
    rerender();
    expect(result.current).toMatchObject(found);
  });

  it("a failed load is the error arm, keeping the last row as `stale` — and no stale row when it was absent", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    const { result, notifications } = mount(live, () => ({
      hit: useLiveRow(c, "r0"),
      miss: useLiveRow(c, "nope"),
    }));
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(`${c.key}:rows`, { ids: "r0" }),
        rows(1),
      );
      live.queryClient.setQueryData(
        queryKeyFor(`${c.key}:rows`, { ids: "nope" }),
        [],
      );
    });
    await waitFor(() => {
      expect(result.current.hit.status).toBe("ready");
      expect(result.current.miss.status).toBe("ready");
    });

    // The one HTTP read path rejects, so a refetch errors the tuple.
    const fetch = vi
      .spyOn(notifications, "fetchOverHttp")
      .mockRejectedValue(new Error("late"));
    await act(async () => {
      await live.queryClient.refetchQueries({ queryKey: [`${c.key}:rows`] });
    });
    fetch.mockRestore();

    await waitFor(() => {
      expect(result.current.hit.status).toBe("error");
      expect(result.current.miss.status).toBe("error");
    });
    const { hit, miss } = result.current;
    if (hit.status !== "error" || miss.status !== "error") {
      throw new Error("unreachable — a failed read is the error arm");
    }
    expect(hit.error.kind).toBe("loader-failed");
    expect(hit.error?.message).toBe("late");
    expect(hit.stale).toEqual(rows(1)[0]);
    expect(miss.error?.message).toBe("late");
    expect("stale" in miss).toBe(false);
  });

  it("keeps its result across a re-render and a deep-equal push; a changed row yields a new one", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    const key = queryKeyFor(`${c.key}:rows`, { ids: "r0" });
    const { result, rerender } = mount(live, () => ({
      hit: useLiveRow(c, "r0"),
      loading: useLiveRow(c, "later"),
      absent: useLiveRow(c, null),
    }));
    const { loading, absent } = result.current;
    act(() => {
      live.queryClient.setQueryData(key, rows(1));
    });
    await waitFor(() => expect(result.current.hit.status).toBe("ready"));
    const hit = result.current.hit;

    rerender();
    rerender();
    expect(result.current.hit).toBe(hit);
    expect(result.current.loading).toBe(loading);
    expect(result.current.absent).toBe(absent);

    // A fresh array with the same row: structural sharing keeps the row.
    act(() => {
      live.queryClient.setQueryData(key, rows(1));
    });
    expect(result.current.hit).toBe(hit);

    const changed = { id: "r0", n: 0, on: false };
    act(() => {
      live.queryClient.setQueryData(key, [changed]);
    });
    await waitFor(() => expect(result.current.hit).not.toBe(hit));
    expect(result.current.hit).toMatchObject({
      status: "ready",
      found: true,
      row: changed,
    });
  });
});

describe("a lookup-only collection", () => {
  const lookup = () =>
    liveCollection(`test.use-live.lookup-${seq++}`, { row: Row, id: "id" });

  it("useLiveRow and an id set read its :rows sibling", async () => {
    const c = lookup();
    const live = createLiveStateHarness();
    const { result } = mount(live, () => ({
      row: useLiveRow(c, "r0"),
      set: useLive(c, { ids: ["r0"] }),
    }));
    expect(result.current.row.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(`${c.key}:rows`, { ids: "r0" }),
        rows(1),
      );
    });
    await waitFor(() => expect(result.current.row.status).toBe("ready"));
    expect(result.current.row).toMatchObject({
      status: "ready",
      found: true,
      row: rows(1)[0],
    });
    const set = result.current.set;
    if (set.status !== "ready") throw new Error("unreachable");
    expect(set.data).toEqual(rows(1));
  });

  it("types: a list read of it is a tsc error — it declares no order to list in", () => {
    const c = lookup();
    // Never called — the assertions are the `@ts-expect-error`s.
    // @ts-expect-error — no default window
    const useWhole = () => useLive(c);
    // @ts-expect-error — no window to filter
    const useWhere = () => useLive(c, { where: { id: "r0" } });
    // @ts-expect-error — no groupings
    const useGrouped = () => useLive(c, { groupBy: "id" });
    expect([useWhole, useWhere, useGrouped]).toHaveLength(3);
  });
});

const Unread = z.object({ errors: z.number(), warnings: z.number() });

describe("useLive — value", () => {
  it("goes loading → settled on the param-less tuple", async () => {
    const v = liveValue(`test.use-live.value.${seq++}`, { schema: Unread });
    const live = createLiveStateHarness();
    const { result } = mount(live, () => useLive(v));
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(v.key, {}), {
        errors: 1,
        warnings: 2,
      });
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.data).toEqual({ errors: 1, warnings: 2 });
  });

  it("a parameterized value subscribes on its params tuple", async () => {
    const v = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      params: ["scope"],
    });
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(v.key, { scope: "a" }), {
      errors: 0,
      warnings: 5,
    });
    const { result } = mount(live, () => useLive(v, { scope: "a" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("a hydrated (boot-snapshot) value is settled on its first render", () => {
    const v = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      preload: "boot",
    });
    expect(v.defaultParams).toEqual({});
    const live = createLiveStateHarness();
    // What the boot task does before first paint: seed the default tuple.
    live.queryClient.setQueryData(queryKeyFor(v.key, v.defaultParams!), {
      errors: 3,
      warnings: 0,
    });
    const seen: string[] = [];
    mount(live, () => {
      const r = useLive(v);
      seen.push(r.status);
      return r;
    });
    expect(seen[0]).toBe("ready");
  });

  it("no placeholder: a never-loaded value makes no HTTP fetch on mount (the WS fills it)", () => {
    const v = liveValue(`test.use-live.value.${seq++}`, { schema: Unread });
    const live = createLiveStateHarness();
    mount(live, () => useLive(v));
    const state = live.queryClient.getQueryState(queryKeyFor(v.key, {}));
    expect(state?.data).toBeUndefined();
    expect(state?.dataUpdatedAt).toBe(0);
    expect(state?.fetchStatus).toBe("idle");
  });

  it('"boot-and-keep" survives past gcTime after unmount; "boot" does not', async () => {
    const kept = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      preload: "boot-and-keep",
    });
    const plain = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      preload: "boot",
    });
    const live = createLiveStateHarness({ queries: { gcTime: 5 } });
    for (const v of [kept, plain]) {
      live.queryClient.setQueryData(queryKeyFor(v.key, {}), {
        errors: 0,
        warnings: 0,
      });
    }
    const a = mount(live, () => useLive(kept));
    const b = mount(live, () => useLive(plain));
    a.unmount();
    b.unmount();
    await waitFor(() =>
      expect(
        live.queryClient.getQueryState(queryKeyFor(plain.key, {})),
      ).toBeUndefined(),
    );
    expect(
      live.queryClient.getQueryState(queryKeyFor(kept.key, {}))?.data,
    ).toEqual({
      errors: 0,
      warnings: 0,
    });
  });

  it("null (no subject yet): loading with no error, nothing read, not a pending mount — until params arrive", async () => {
    const v = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      params: ["id"],
    });
    const live = createLiveStateHarness();
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const before = pendingMountSnapshot().pending;
    let id: string | null = null;
    const { result, rerender } = mount(live, () =>
      useLive(v, id === null ? null : { id }),
    );
    expect(result.current).toMatchObject({ status: "loading" });
    expect(observe.mock.calls.filter(([key]) => key === v.key)).toEqual([]);
    expect(pendingMountSnapshot().pending).toBe(before);
    // The skipped query can never fetch: refetch is a no-op.
    await result.current.refetch();
    expect(
      live.queryClient
        .getQueryCache()
        .findAll({ queryKey: [v.key] })
        .every((q) => q.state.fetchStatus === "idle"),
    ).toBe(true);

    id = "a";
    rerender();
    expect(
      observe.mock.calls
        .filter(([key]) => key === v.key)
        .map(([, params]) => params),
    ).toEqual([{ id: "a" }]);
    observe.mockRestore();
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(v.key, { id: "a" }), {
        errors: 1,
        warnings: 0,
      });
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("an absent optional param is one tuple however it is spelled", () => {
    const v = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      params: ["path", "scopeId?"],
    });
    const live = createLiveStateHarness();
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    // Seeded under the canonical `{ path }` — every spelling reads it.
    live.queryClient.setQueryData(queryKeyFor(v.key, { path: "p" }), {
      errors: 7,
      warnings: 0,
    });
    const { result } = mount(live, () => [
      useLive(v, { path: "p" }),
      useLive(v, { path: "p", scopeId: undefined }),
      useLive(v, { path: "p", scopeId: "" }),
    ]);
    for (const r of result.current) expect(r.status).toBe("ready");
    const subs = observe.mock.calls
      .filter(([key]) => key === v.key)
      .map(([, params]) => params);
    expect(subs).toEqual([{ path: "p" }, { path: "p" }, { path: "p" }]);
    observe.mockRestore();
  });

  it('"boot-and-keep": a hydrated tuple nobody has observed outlives the default gcTime; "boot" does not', () => {
    vi.useFakeTimers();
    try {
      const kept = liveValue(`test.use-live.value.${seq++}`, {
        schema: Unread,
        params: ["path"],
        preload: "boot-and-keep",
      });
      const plain = liveValue(`test.use-live.value.${seq++}`, {
        schema: Unread,
        preload: "boot",
      });
      // What the boot snapshot does, on the app's default client.
      hydrateResource(kept, { path: "a" }, { errors: 1, warnings: 0 });
      hydrateResource(plain, {}, { errors: 2, warnings: 0 });
      // Past React Query's default gcTime (5 min), nothing mounted.
      vi.advanceTimersByTime(10 * 60_000);
      const seen: boolean[][] = [];
      renderHook(
        () => {
          const r = [
            useLive(kept, { path: "a" }).status !== "ready",
            useLive(plain).status !== "ready",
          ];
          seen.push(r);
          return r;
        },
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <NotificationsProvider>{children}</NotificationsProvider>
          ),
        },
      );
      expect(seen[0]).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("types: params are required iff declared; null (no subject yet) only for a param'd value", () => {
    const bare = liveValue(`test.use-live.value.${seq++}`, { schema: Unread });
    const keyed = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      params: ["id"],
    });
    const optional = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      params: ["path", "scopeId?"],
    });
    // Never called — the assertions are the `@ts-expect-error`s.
    const useTypeOnly = () => {
      useLive(bare);
      // @ts-expect-error — a param-less value takes no params
      useLive(bare, { id: "x" });
      // @ts-expect-error — a param-less value always has its subject
      useLive(bare, null);
      useLive(keyed, { id: "x" });
      useLive(keyed, null);
      // @ts-expect-error — a parameterized value's params are required
      useLive(keyed);
      // @ts-expect-error — only the declared names
      useLive(keyed, { other: "x" });
      useLive(optional, { path: "p" });
      useLive(optional, { path: "p", scopeId: "s" });
      useLive(optional, { path: "p", scopeId: undefined });
      const maybe: { path: string } | null = null;
      useLive(optional, maybe);
      // @ts-expect-error — an optional param does not make a required one optional
      useLive(optional, { scopeId: "s" });
    };
    expect(typeof useTypeOnly).toBe("function");
  });

  it("types: a typed param narrows the params useLive takes to its parser's output", () => {
    const typed = liveValue(`test.use-live.value.${seq++}`, {
      schema: Unread,
      params: { window: z.enum(["1h", "24h", "7d"]) },
    });
    // Never called — the assertions are the `@ts-expect-error`s.
    const useTypeOnly = (window: "1h" | "24h" | "7d") => {
      useLive(typed, { window: "1h" });
      useLive(typed, { window });
      useLive(typed, null);
      // @ts-expect-error — "2h" is not a declared window
      useLive(typed, { window: "2h" });
      // @ts-expect-error — a plain string is wider than the parser's output
      useLive(typed, { window: String(window) });
      // @ts-expect-error — the typed param is required
      useLive(typed, {});
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});

describe("status arms", () => {
  it("a window goes loading → ready", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    const { result } = mount(live, () => useLive(c));
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.key, { limit: "2" }),
        rows(2),
      );
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.status).toBe("ready");
  });

  it("a new page that fails is the error arm, with the rows shown as `stale`", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(c.key, { limit: "2" }), keyed(2));
    const { result } = mount(live, () => useLive(c));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error("unreachable");
      r.loadMore();
    });
    expect(result.current.status).toBe("ready"); // growing, on the rows shown

    const head = queryKeyFor(
      c.key,
      c.window.window.encode({ limit: 4 }, { until: keyOf(1) }),
    );
    const next = queryKeyFor(
      c.key,
      c.window.window.encode({ limit: 2 }, { after: keyOf(1) }),
    );
    act(() => {
      live.queryClient.setQueryData(head, keyed(2));
    });
    // The new page's read fails the way a failed sub heals: the fetch runs
    // directly on the query (`fetchAfterSubError`'s `prefetchQuery`) — a
    // placeholder-less window query is disabled until its first value, so
    // `refetchQueries` would skip it.
    await act(async () => {
      await live.queryClient.prefetchQuery({
        queryKey: next,
        queryFn: () => Promise.reject(new Error("page failed")),
        staleTime: 0,
      });
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error.message).toBe("page failed");
    expect(r.stale).toEqual(rows(2));

    // The page's read recovering recovers the list.
    act(() => {
      live.queryClient.setQueryData(next, keyed(4, 2));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const grown = result.current;
    if (grown.status !== "ready") throw new Error("unreachable");
    expect(grown.data).toEqual(rows(4));
  });

  it("useLiveRow carries refetch on every arm; refetch from the error arm recovers", async () => {
    const c = collection();
    const live = createLiveStateHarness();
    const { result, notifications } = mount(live, () => useLiveRow(c, "r0"));
    expect(result.current.status).toBe("loading");
    expect(typeof result.current.refetch).toBe("function");

    const fail = vi
      .spyOn(notifications, "fetchOverHttp")
      .mockRejectedValue(new Error("boom"));
    await act(async () => {
      await result.current.refetch();
    });
    fail.mockRestore();
    await waitFor(() => expect(result.current.status).toBe("error"));

    vi.spyOn(notifications, "fetchOverHttp").mockResolvedValue(rows(1));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ found: true, row: rows(1)[0] });
  });
});

describe("useLive — a window's rows", () => {
  it("hands rows out without `$key` — the error arm's last-known rows too", async () => {
    const c = liveCollection(`test.use-live.scroll.${seq++}`, {
      row: Row,
      id: "id",
      filterable: { on: liveBoolean() },
      sortable: ["n"],
      default: { orderBy: [["n", "asc"]], limit: 2 },
      maxLimit: 6,
    });
    const live = createLiveStateHarness();
    const { result, notifications } = mount(live, () => useLive(c));
    const keyed = rows(2).map((r) => ({ ...r, $key: `["${r.n}","${r.id}"]` }));
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(c.key, { limit: "2" }), keyed);
    });
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "ready", data: rows(2) }),
    );

    const fetch = vi
      .spyOn(notifications, "fetchOverHttp")
      .mockRejectedValue(new Error("late"));
    await act(async () => {
      await live.queryClient.refetchQueries({ queryKey: [c.key] });
    });
    fetch.mockRestore();
    await waitFor(() => expect(result.current.status).toBe("error"));
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.stale).toEqual(rows(2));
  });
});
