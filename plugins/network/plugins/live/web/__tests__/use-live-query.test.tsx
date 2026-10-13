/**
 * useLive over a typed-query value and a key-range-paged value, on a
 * `createLiveStateHarness` (the use-live.test.tsx harness):
 * authoritative values are driven with `queryClient.setQueryData` on the exact tuple
 * the declaration's codec encodes — the same call a WS sub-ack makes. (The
 * paged read's plan and hook are a collection window's, pinned in
 * `use-pages.test.tsx`; here, what a VALUE source changes.)
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { renderHook, waitFor, act } from "@testing-library/react";
import { z } from "zod";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import {
  NotificationsClient,
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { liveValue } from "@plugins/network/plugins/live/core";
import { mintVisibleRange, useLive } from "@plugins/network/plugins/live/web";

const Result = z.object({ n: z.number() });
const Query = z.object({ metric: z.string(), days: z.number().default(7) });
const Item = z.object({ id: z.string(), at: z.string() });
type Item = z.output<typeof Item>;
const Meta = z.object({ total: z.number() });

let seq = 0;
const key = () => `test.use-live-query.${seq++}`;

function mount<R>(live: LiveStateHarness, useHook: () => R) {
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const rendered = renderHook(useHook, { wrapper: live.Wrapper });
  return { ...rendered, notifications: live.notifications };
}

/** Items at descending `at`s ("9", "8", …), each with the `$key` the server mints. */
const wire = (...ids: string[]) =>
  ids.map((id, i) => ({
    id,
    at: String(9 - i),
    $key: JSON.stringify([String(9 - i), id]),
  }));
const items = (...ids: string[]): Item[] =>
  wire(...ids).map(({ $key: _k, ...item }) => item);

describe("useLive — typed-query value", () => {
  it("subscribes on the question's canonical tuple, and goes loading → ready", async () => {
    const v = liveValue(key(), { schema: Result, query: Query });
    const live = createLiveStateHarness();
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const { result } = mount(live, () => useLive(v, { metric: "m" }));
    expect(result.current.status).toBe("loading");
    const tuple = { q: '{"days":7,"metric":"m"}' };
    expect(
      observe.mock.calls.filter(([k]) => k === v.key).map(([, p]) => p),
    ).toEqual([tuple]);
    observe.mockRestore();
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(v.key, tuple), { n: 3 });
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ data: { n: 3 } });
  });

  it("a changed question is a new tuple: it shows loading", async () => {
    const v = liveValue(key(), { schema: Result, query: Query });
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(v.key, v.query.encode({ metric: "a" })),
      {
        n: 1,
      },
    );
    let metric = "a";
    const { result, rerender } = mount(live, () => useLive(v, { metric }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    metric = "b";
    rerender();
    expect(result.current.status).toBe("loading");
  });

  it("a refetch (an invalidate) keeps the previous answer on screen", async () => {
    const v = liveValue(key(), { schema: Result, query: Query });
    const live = createLiveStateHarness();
    const tuple = v.query.encode({ metric: "m" });
    live.queryClient.setQueryData(queryKeyFor(v.key, tuple), { n: 1 });
    const { result, notifications } = mount(live, () =>
      useLive(v, { metric: "m" }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let land: ((value: unknown) => void) | undefined;
    vi.spyOn(notifications, "fetchOverHttp").mockReturnValue(
      new Promise((resolve) => {
        land = resolve;
      }) as never,
    );
    let refetched: Promise<void> | undefined;
    act(() => {
      refetched = result.current.refetch();
    });
    expect(result.current).toMatchObject({ status: "ready", data: { n: 1 } });
    await act(async () => {
      land!({ n: 2 });
      await refetched;
    });
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "ready", data: { n: 2 } }),
    );
  });

  it("null reads nothing", () => {
    const v = liveValue(key(), { schema: Result, query: Query });
    const live = createLiveStateHarness();
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const { result } = mount(live, () => useLive(v, null));
    expect(result.current.status).toBe("loading");
    expect(observe.mock.calls.filter(([k]) => k === v.key)).toEqual([]);
    observe.mockRestore();
  });

  it("types: the question is the schema's input; it is required", () => {
    const v = liveValue(key(), { schema: Result, query: Query });
    // Never called — the assertions are the `@ts-expect-error`s.
    const useTypeOnly = () => {
      useLive(v, { metric: "m" });
      useLive(v, { metric: "m", days: 2 });
      useLive(v, null);
      // @ts-expect-error — a query value's question is required
      useLive(v);
      // @ts-expect-error — the wire tuple is not the question
      useLive(v, { q: "{}" });
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});

describe("useLive — paged value", () => {
  function paged() {
    return liveValue(key(), {
      query: z.object({ metric: z.string() }),
      paged: {
        item: Item,
        id: "id",
        key: { of: (i: Item) => [i.at], order: ["desc"] },
        limit: 2,
        maxLimit: 4,
        meta: Meta,
      },
    });
  }
  const q = '{"metric":"m"}';

  it("no viewport: page 0 is { q, limit }, `$key` is split off, and loadMore splits without flashing", async () => {
    const v = paged();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(v.key, { q, limit: "2" }),
      wire("a", "b"),
    );
    const { result } = mount(live, () => useLive(v, { metric: "m" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current;
    if (first.status !== "ready") throw new Error("unreachable");
    expect(first.data).toEqual(items("a", "b"));
    expect(first.canGrow).toBe(true);

    act(() => first.loadMore());
    // The split pages have not landed: the rows stay, growing.
    expect(result.current).toMatchObject({
      status: "ready",
      growing: true,
      data: items("a", "b"),
    });
    const cut = JSON.stringify(["8", "b"]);
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(v.key, { q, limit: "4", until: cut }),
        wire("a", "b"),
      );
      live.queryClient.setQueryData(
        queryKeyFor(v.key, { q, limit: "2", after: cut }),
        wire("a", "b", "c", "d").slice(2),
      );
    });
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "ready", growing: false }),
    );
    const grown = result.current;
    if (grown.status !== "ready") throw new Error("unreachable");
    expect(grown.data).toEqual(items("a", "b", "c", "d"));
    // 4 + a step would pass maxLimit: a read with no viewport stops there.
    expect(grown.canGrow).toBe(false);
  });

  it("{ limit } is page 0's limit — a preview — and the step", async () => {
    const v = paged();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(v.key, { q, limit: "1" }),
      wire("a"),
    );
    const { result } = mount(live, () =>
      useLive(v, { metric: "m" }, { limit: 1 }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ data: items("a"), canGrow: true });
  });

  it("with a viewport: the pages result", async () => {
    const v = paged();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(v.key, { q, limit: "2" }),
      wire("a"),
    );
    const viewport = mintVisibleRange({ kind: "measuring" });
    const { result } = mount(live, () =>
      useLive(v, { metric: "m" }, { viewport }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({
      status: "ready",
      rows: items("a"),
      exhausted: true,
      pageErrors: [],
    });
  });

  it("a failed page under the items shown is the error arm with them as stale", async () => {
    const v = paged();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(
      queryKeyFor(v.key, { q, limit: "2" }),
      wire("a", "b"),
    );
    const { result } = mount(live, () => useLive(v, { metric: "m" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error("unreachable");
      r.loadMore();
    });
    const cut = JSON.stringify(["8", "b"]);
    await act(async () => {
      live.queryClient.setQueryData(
        queryKeyFor(v.key, { q, limit: "4", until: cut }),
        wire("a", "b"),
      );
      await live.queryClient.prefetchQuery({
        queryKey: queryKeyFor(v.key, { q, limit: "2", after: cut }),
        queryFn: () => Promise.reject(new Error("page failed")),
        staleTime: 0,
      });
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error.message).toBe("page failed");
    expect(r.stale).toEqual(items("a", "b"));
  });

  it("the meta sibling is a typed-query value over the same question", async () => {
    const v = paged();
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(v.meta.key, { q }), { total: 4 });
    const { result } = mount(live, () => useLive(v.meta, { metric: "m" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ data: { total: 4 } });
  });

  it("null reads nothing", () => {
    const v = paged();
    const live = createLiveStateHarness();
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const { result } = mount(live, () => useLive(v, null));
    expect(result.current.status).toBe("loading");
    expect(observe.mock.calls.filter(([k]) => k === v.key)).toEqual([]);
    observe.mockRestore();
  });

  it("a limit past maxLimit throws", () => {
    const v = paged();
    const live = createLiveStateHarness();
    expect(() =>
      mount(live, () => useLive(v, { metric: "m" }, { limit: 5 })),
    ).toThrow(/not an integer in 1..4/);
  });
});
