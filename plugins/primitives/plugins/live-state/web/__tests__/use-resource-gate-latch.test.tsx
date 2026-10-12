/**
 * `useResource(…, { select, gate: true })`'s latch is DERIVED from the query
 * cache (P8 v3 C17, D29): the read is select-scoped exactly when its tuple's
 * query holds a value (`dataUpdatedAt` past epoch 0), with no settle effect
 * held as state. Pinned here against a REAL `QueryClient` (the
 * use-resource-error-gate.test.tsx harness):
 *
 *   - a tuple already cached (boot-hydrated) renders ONCE, ready, the slice
 *     applied — no widened render followed by a narrowed one;
 *   - a tuple with no value yet still flips loading → ready even when the slice
 *     is identical across the no-value → value boundary: a selector answering
 *     `undefined` for the first value leaves `data` unchanged (the gate's job),
 *     and the landed `undefined` slice reads `ready`, not `loading`;
 *   - once settled, a push that leaves the slice equal re-renders nothing;
 *   - a params change re-gates for a tuple with no value yet, and starts
 *     narrowed for one already cached;
 *   - the latch listens to the query cache only while it is OPEN: a read
 *     whose tuple holds a value adds no cache listener (every cache event of
 *     any query runs every listener, so one per settled read would make a push
 *     cost O(observers × gated reads)), and an open read's listener is gone
 *     once the value lands;
 *   - a selector that may be absent types its data as `T | S`, never `S`.
 *
 * Authoritative pushes are `queryClient.setQueryData` on the exact tuple — the call
 * a WS sub-ack / update makes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  queryKeyFor,
  type ResourceResult,
  useResource,
} from "@plugins/primitives/plugins/live-state/web";
import type { ResourceDescriptor } from "@plugins/primitives/plugins/live-state/core";
import { createLiveStateHarness, type LiveStateHarness } from "../testing";

const rowsResource: ResourceDescriptor<number[], { id: string }> = {
  key: "test.gate-latch.rows",
  schema: z.array(z.number()),
  validateParams: () => {},
};
const keyOf = (id: string) => queryKeyFor(rowsResource.key, { id });

// The slice is the same before and after the first value: no data yet and
// `[0]` both read `undefined` — the silent flip the gate exists for.
const firstPositive = (rows: number[]): number | undefined =>
  rows.find((n) => n > 0);
const anyPositive = (rows: number[]): boolean => rows.some((n) => n > 0);

function mount<R, P>(
  live: LiveStateHarness,
  useHook: (props: P) => R,
  initialProps: P,
) {
  const renders: R[] = [];
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const rendered = renderHook(
    (props: P) => {
      const r = useHook(props);
      renders.push(r);
      return r;
    },
    { wrapper: live.Wrapper, initialProps },
  );
  return { ...rendered, renders };
}

const useGated = ({ id }: { id: string }) =>
  useResource(rowsResource, { id }, { select: firstPositive, gate: true });

/** One select read of tuple `a`, gated or not (the same hooks either way). */
const useMaybeGated = ({ gated }: { gated: boolean }) =>
  useResource(rowsResource, { id: "a" }, { select: anyPositive, gate: gated });

/**
 * Count the query cache's live listeners: every `subscribe` through the spy
 * adds one, and its unsubscribe (however often called) removes it once.
 */
function countCacheListeners(client: QueryClient): () => number {
  const cache = client.getQueryCache();
  const subscribe = cache.subscribe.bind(cache);
  let active = 0;
  vi.spyOn(cache, "subscribe").mockImplementation((listener) => {
    const unsubscribe = subscribe(listener);
    active += 1;
    let live = true;
    return () => {
      if (live) {
        live = false;
        active -= 1;
      }
      unsubscribe();
    };
  });
  return () => active;
}

/** Let React Query's batched notifications run, so a missing re-render shows. */
async function settleNotifications(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("useResource gate — the derived latch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a tuple already cached renders once: ready, select-scoped, on the first render", async () => {
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(keyOf("a"), [1, 2]);
    const { renders } = mount(live, useGated, { id: "a" });
    await settleNotifications();
    expect(renders).toHaveLength(1);
    const first = renders[0]!;
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("unreachable");
    expect(first.data).toBe(1);
  });

  it("a tuple with no value flips loading → ready even when the slice is unchanged across the boundary", async () => {
    const live = createLiveStateHarness();
    const { result } = mount(live, useGated, { id: "a" });
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(keyOf("a"), [0]);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.data).toBeUndefined();
  });

  it("once settled, a push that leaves the slice equal re-renders nothing; one that moves it does", async () => {
    const live = createLiveStateHarness();
    const { result, renders } = mount(live, useGated, { id: "a" });
    act(() => {
      live.queryClient.setQueryData(keyOf("a"), [0]);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await settleNotifications();
    const settledRenders = renders.length;

    act(() => {
      live.queryClient.setQueryData(keyOf("a"), [0, 0]);
    });
    await settleNotifications();
    expect(renders).toHaveLength(settledRenders);

    act(() => {
      live.queryClient.setQueryData(keyOf("a"), [0, 3]);
    });
    await waitFor(() => {
      const r = result.current;
      expect(r.status === "ready" && r.data).toBe(3);
    });
  });

  it("a params change re-gates a tuple with no value, and starts narrowed on one already cached", async () => {
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(keyOf("a"), [1]);
    live.queryClient.setQueryData(keyOf("c"), [0]);
    const { result, rerender, renders } = mount(live, useGated, {
      id: "a",
    });
    expect(result.current.status).toBe("ready");

    // b: no value — loading, then its first value renders even though the
    // slice (`undefined`) is what the read held before it too.
    rerender({ id: "b" });
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(keyOf("b"), [0]);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const onB = result.current;
    if (onB.status !== "ready") throw new Error("unreachable");
    expect(onB.data).toBeUndefined();
    await settleNotifications();

    // c: cached — ready on the switching render itself, nothing after it.
    const before = renders.length;
    rerender({ id: "c" });
    await settleNotifications();
    expect(renders).toHaveLength(before + 1);
    const onC = renders.at(-1)!;
    expect(onC.status).toBe("ready");
    if (onC.status !== "ready") throw new Error("unreachable");
    expect(onC.data).toBeUndefined();
  });

  it("a read whose tuple holds a value adds no cache listener", async () => {
    const live = createLiveStateHarness();
    live.queryClient.setQueryData(keyOf("a"), [1]);
    const listeners = countCacheListeners(live.queryClient);
    const { rerender, result } = mount(live, useMaybeGated, {
      gated: false,
    });
    await settleNotifications();
    const plain = listeners();

    rerender({ gated: true });
    await settleNotifications();
    expect(result.current.status).toBe("ready");
    expect(listeners()).toBe(plain);
  });

  it("an open read listens until its value lands, then stops", async () => {
    const live = createLiveStateHarness();
    const listeners = countCacheListeners(live.queryClient);
    const { rerender, result } = mount(live, useMaybeGated, {
      gated: false,
    });
    await settleNotifications();
    const plain = listeners();

    rerender({ gated: true });
    await settleNotifications();
    expect(result.current.status).toBe("loading");
    expect(listeners()).toBe(plain + 1);

    act(() => {
      live.queryClient.setQueryData(keyOf("a"), [0]);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await settleNotifications();
    expect(listeners()).toBe(plain);
  });

  it("types: a selector that may be absent reads `T | S`, never the slice alone", () => {
    // Never called — the assertions are the types and `@ts-expect-error`s.
    const useTypeOnly = (withSelect: boolean) => {
      const select = withSelect ? anyPositive : undefined;
      const either: ResourceResult<boolean | number[]> = useResource(
        rowsResource,
        { id: "a" },
        { gate: true, select },
      );
      // @ts-expect-error — the whole `number[]` comes back when `select` is absent
      const slice: ResourceResult<boolean> = useResource(
        rowsResource,
        { id: "a" },
        { gate: true, select },
      );
      const whole: ResourceResult<number[]> = useResource(
        rowsResource,
        { id: "a" },
        { gate: true },
      );
      const sliced: ResourceResult<boolean> = useResource(
        rowsResource,
        { id: "a" },
        { gate: true, select: anyPositive },
      );
      return [either, slice, whole, sliced];
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});
