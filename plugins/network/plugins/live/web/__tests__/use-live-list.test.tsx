/**
 * useLive over a LIST of tuples of one value (`useLive(v, [p1, p2, …])`, plan
 * research/2026-10-11-global-endpoint-reads-onto-live.md P0.6): one result
 * per entry in order, `null` entries skipped, the set moved by diff so a kept
 * tuple stays subscribed and settled, a duplicate read once, and the typed-query
 * form encoding each question. Harness: a real NotificationsProvider +
 * QueryClient; values land with `live.queryClient.setQueryData` on the exact tuple (the
 * call a WS sub-ack makes), as in use-live-query.test.tsx.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { renderHook, waitFor, act } from "@testing-library/react";
import { z } from "zod";
import {
  queryKeyFor,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
  NotificationsClient,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { liveValue } from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import type { LiveSnapshotResult } from "../internal/use-live";

const Result = z.object({ n: z.number() });
const Query = z.object({ metric: z.string(), days: z.number().default(7) });

let seq = 0;
const key = () => `test.use-live-list.${seq++}`;

function mount<Props, R>(
  live: LiveStateHarness,
  useHook: (props: Props) => R,
  initialProps: Props,
) {
  const notifications = live.notifications;
  // Before the first render: a fresh client would cold-start prime over HTTP.
  vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
  const rendered = renderHook(useHook, { wrapper: live.Wrapper, initialProps });
  return { ...rendered, notifications };
}

type Dir = { dir: string };
const dir = (d: string): Dir => ({ dir: d });

/** Each result's settled `n`, or its status. */
const shape = (results: readonly ResourceResult<{ n: number }>[]) =>
  results.map((r) => (r.status === "ready" ? r.data.n : r.status));

describe("useLive(value, [p1, p2, …])", () => {
  it("returns one result per tuple, in order", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const live = createLiveStateHarness();
    const { result } = mount(
      live,
      ({ list }: { list: Dir[] }) => useLive(v, list),
      { list: [dir("a"), dir("b"), dir("c")] },
    );
    expect(shape(result.current)).toEqual(["loading", "loading", "loading"]);
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(v.key, dir("c")), { n: 3 });
      live.queryClient.setQueryData(queryKeyFor(v.key, dir("a")), { n: 1 });
    });
    await waitFor(() =>
      expect(shape(result.current)).toEqual([1, "loading", 3]),
    );
  });

  it("a growing, shrinking or reordered list keeps settled tuples — subscribed once, never re-observed", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(v.key, dir("a")), { n: 1 });
    live.queryClient.setQueryData(queryKeyFor(v.key, dir("b")), { n: 2 });
    const { result, rerender, unmount } = mount(
      live,
      ({ list }: { list: Dir[] }) => useLive(v, list),
      { list: [dir("a"), dir("b")] },
    );
    await waitFor(() => expect(shape(result.current)).toEqual([1, 2]));
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const unobserve = vi.spyOn(NotificationsClient.prototype, "unobserve");
    const names = (spy: typeof observe | typeof unobserve) =>
      spy.mock.calls
        .filter(([k]) => k === v.key)
        .map(([, p]) => (p as Dir).dir);
    const aData =
      result.current[0]!.status === "ready" ? result.current[0]!.data : null;

    // Grow: c is read; a and b stay settled (same data object), untouched.
    rerender({ list: [dir("a"), dir("b"), dir("c")] });
    expect(shape(result.current)).toEqual([1, 2, "loading"]);
    expect(names(observe)).toEqual(["c"]);
    expect(names(unobserve)).toEqual([]);

    // Shrink and reorder: b leaves; a keeps its settled value at its new place.
    rerender({ list: [dir("c"), dir("a")] });
    expect(shape(result.current)).toEqual(["loading", 1]);
    const a = result.current[1]!;
    expect(a.status === "ready" ? a.data : null).toBe(aData);
    expect(names(observe)).toEqual(["c"]);
    expect(names(unobserve)).toEqual(["b"]);

    unmount();
    expect(names(unobserve).sort()).toEqual(["a", "b", "c"]);
    observe.mockRestore();
    unobserve.mockRestore();
  });

  it("a null entry is a skip: loading, nothing read; it fills in when its subject arrives", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(queryKeyFor(v.key, dir("a")), { n: 1 });
    live.queryClient.setQueryData(queryKeyFor(v.key, dir("b")), { n: 2 });
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const { result, rerender } = mount(
      live,
      ({ list }: { list: (Dir | null)[] }) => useLive(v, list),
      { list: [null, dir("a"), null] },
    );
    await waitFor(() =>
      expect(shape(result.current)).toEqual(["loading", 1, "loading"]),
    );
    expect(
      observe.mock.calls.filter(([k]) => k === v.key).map(([, p]) => p),
    ).toEqual([dir("a")]);
    rerender({ list: [dir("b"), dir("a"), null] });
    await waitFor(() =>
      expect(shape(result.current)).toEqual([2, 1, "loading"]),
    );
    observe.mockRestore();
  });

  it("reads a tuple listed twice once — an absent optional param is the same tuple", async () => {
    const v = liveValue(key(), {
      schema: Result,
      params: ["dir", "scope?"],
    });
    const live = createLiveStateHarness();
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const { result } = mount(
      live,
      () => useLive(v, [{ dir: "a" }, { dir: "a", scope: "" }, { dir: "a" }]),
      undefined,
    );
    expect(
      observe.mock.calls.filter(([k]) => k === v.key).map(([, p]) => p),
    ).toEqual([{ dir: "a" }]);
    observe.mockRestore();
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(v.key, { dir: "a" }), { n: 5 });
    });
    await waitFor(() => expect(shape(result.current)).toEqual([5, 5, 5]));
  });

  it("an empty list reads nothing and returns no results", () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const { result } = mount(
      createLiveStateHarness(),
      () => useLive(v, []),
      undefined,
    );
    expect(result.current).toEqual([]);
  });

  it("a typed-query value takes a list of questions, each encoded to its one tuple", async () => {
    const v = liveValue(key(), { schema: Result, query: Query });
    const live = createLiveStateHarness();
    const { result } = mount(
      live,
      () => useLive(v, [{ metric: "x" }, null, { metric: "y", days: 3 }]),
      undefined,
    );
    expect(shape(result.current)).toEqual(["loading", "loading", "loading"]);
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(v.key, { q: '{"days":3,"metric":"y"}' }),
        { n: 3 },
      );
      live.queryClient.setQueryData(
        queryKeyFor(v.key, v.query.encode({ metric: "x" })),
        {
          n: 7,
        },
      );
    });
    await waitFor(() =>
      expect(shape(result.current)).toEqual([7, "loading", 3]),
    );
  });

  it("a snapshot value's list results each add refresh()", async () => {
    const v = liveValue(key(), {
      schema: Result,
      params: ["dir"],
      load: "snapshot",
    });
    const fetch = vi
      .spyOn(NotificationsClient.prototype, "fetchOverHttp")
      .mockImplementation((_key, params) =>
        Promise.resolve({
          n: (params as Dir).dir === "a" ? 1 : 2,
        } as never),
      );
    const { result } = mount(
      createLiveStateHarness(),
      () => useLive(v, [dir("a"), dir("b")]),
      undefined,
    );
    await waitFor(() => expect(shape(result.current)).toEqual([1, 2]));
    const reads: readonly LiveSnapshotResult<{ n: number }, never>[] =
      result.current;
    const before = fetch.mock.calls.length;
    await act(() => reads[0]!.refresh());
    expect(fetch.mock.calls.length).toBe(before + 1);
    expect((fetch.mock.calls.at(-1)![1] as Dir).dir).toBe("a");
    fetch.mockRestore();
  });

  it("refuses a question schema that is itself a list (it would read as one)", () => {
    expect(() =>
      liveValue(key(), { schema: Result, query: z.array(z.string()) }),
    ).toThrow(/may be a list \(ZodArray\)/);
    expect(() =>
      liveValue(key(), {
        schema: Result,
        query: z.union([z.object({ a: z.string() }), z.tuple([z.string()])]),
      }),
    ).toThrow(/may be a list \(ZodTuple\)/);
    expect(() =>
      liveValue(key(), {
        schema: Result,
        query: z.array(z.string()).optional(),
      }),
    ).toThrow(/ZodArray/);
  });

  it("types: a list in, a list of the single read's results out", () => {
    const v = liveValue(key(), {
      schema: Result,
      params: ["dir", "scope?"],
      refusals: ["missing"],
    });
    const q = liveValue(key(), {
      schema: Result,
      query: Query,
    });
    const none = liveValue(key(), { schema: Result });
    const snap = liveValue(key(), {
      schema: Result,
      params: ["dir"],
      load: "snapshot",
    });
    const paged = liveValue(key(), {
      query: Query,
      paged: {
        item: z.object({ id: z.string() }),
        id: "id",
        key: { of: (i: { id: string }) => [i.id], order: ["asc"] },
        limit: 10,
        maxLimit: 20,
      },
    });

    // Never called — the assertions are the annotations and `@ts-expect-error`s.
    const useTypeOnly = () => {
      const list: readonly ResourceResult<{ n: number }, "missing">[] = useLive(
        v,
        [{ dir: "a" }, null, { dir: "b", scope: "s" }],
      );
      // The single form is unchanged: an object is one tuple.
      const one: ResourceResult<{ n: number }, "missing"> = useLive(v, {
        dir: "a",
      });
      const qs: readonly ResourceResult<{ n: number }, never>[] = useLive(q, [
        { metric: "m" },
        null,
      ]);
      const snaps: readonly LiveSnapshotResult<{ n: number }, never>[] =
        useLive(snap, [{ dir: "a" }]);
      // @ts-expect-error — refresh() is typed only on a snapshot value's reads
      void list[0]!.refresh;
      // @ts-expect-error — an undeclared param name in a list entry
      useLive(v, [{ dir: "a", bogus: "x" }]);
      // @ts-expect-error — a missing required param in a list entry
      useLive(v, [{ scope: "s" }]);
      // @ts-expect-error — a param-less value has no list form
      useLive(none, [{}]);
      // @ts-expect-error — a question the schema does not take
      useLive(q, [{ metric: 1 }]);
      // @ts-expect-error — a typed-query value's list is of questions, not `{ q }` tuples
      useLive(q, [{ q: "{}" }]);
      // @ts-expect-error — a paged value reads one question
      useLive(paged, [{ metric: "m" }]);
      // @ts-expect-error — the list form returns an array, not one result
      const wrong: ResourceResult<{ n: number }, "missing"> = useLive(v, [
        { dir: "a" },
      ]);
      return { one, qs, snaps, wrong };
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});
