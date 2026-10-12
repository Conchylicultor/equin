/**
 * `useResources` — a varying list of tuples of one resource, each read exactly
 * as `useResource` reads one. Over a real NotificationsProvider + QueryClient:
 *
 * - the subscription set moves by DIFF: add / remove / reorder observe and
 *   unobserve only the tuples that entered or left, and a kept tuple is never
 *   unobserved (its socket subscription would lapse);
 * - a tuple also read by a `useResource` shares its refcount: unmounting one
 *   reader leaves it subscribed for the other;
 * - each tuple's result is `useResource`'s: loading until its own value lands;
 * - each tuple's mount→settle is reported once, as `useResource` reports its one;
 * - `release: "now"` lets a dropped tuple go at once (unmount keeps the
 *   keep-alive), and each tuple carries its `appliedSeq`.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { z } from "zod";
import {
  NotificationsProvider,
  getNotificationsClient,
  pendingMountSnapshot,
  queryKeyFor,
  slowResourceReportSink,
  useResource,
  useResources,
} from "@plugins/primitives/plugins/live-state/web";
import type { SlowResourceInfo } from "../slow-resource-reporter";
import {
  registerResourceDescriptor,
  type ResourceDescriptor,
} from "@plugins/primitives/plugins/live-state/core";

let seq = 0;
/** A pushed descriptor (a `liveValue`'s shape): loading until a value lands. */
const descriptor = (): ResourceDescriptor<number[], { n: string }> => {
  const d: ResourceDescriptor<number[], { n: string }> = {
    key: `test.use-resources.${seq++}`,
    schema: z.array(z.number()),
    validateParams: () => {},
  };
  registerResourceDescriptor(d as ResourceDescriptor<unknown>);
  return d;
};

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, staleTime: Infinity },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <NotificationsProvider queryClient={client}>
      {children}
    </NotificationsProvider>
  );
}

function spyNotifications() {
  const notifications = getNotificationsClient();
  if (!notifications) throw new Error("NotificationsClient not created");
  vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
  const observe = vi.spyOn(notifications, "observe");
  const unobserve = vi.spyOn(notifications, "unobserve");
  const names = (spy: typeof observe | typeof unobserve) =>
    spy.mock.calls.map((c) => (c[1] as { n: string }).n);
  return { notifications, observe, unobserve, names };
}

const tuple = (n: string) => ({ n });

describe("useResources", () => {
  it("observes each tuple once, and moves the set by diff on add / remove / reorder", () => {
    const d = descriptor();
    const client = makeClient();
    // Mount once so the provider creates the client, then spy.
    const { rerender, unmount } = renderHook(
      ({ list }: { list: { n: string }[] }) => useResources(d, list),
      {
        wrapper: wrapperFor(client),
        initialProps: { list: [tuple("a"), tuple("b")] },
      },
    );
    const { observe, unobserve, names } = spyNotifications();
    observe.mockClear();
    unobserve.mockClear();

    // Add c, keep a and b.
    rerender({ list: [tuple("a"), tuple("b"), tuple("c")] });
    expect(names(observe)).toEqual(["c"]);
    expect(names(unobserve)).toEqual([]);

    // Reorder: nothing enters or leaves.
    rerender({ list: [tuple("c"), tuple("a"), tuple("b")] });
    expect(names(observe)).toEqual(["c"]);
    expect(names(unobserve)).toEqual([]);

    // Replace b with d: d observed, b unobserved; a and c untouched.
    rerender({ list: [tuple("c"), tuple("a"), tuple("d")] });
    expect(names(observe)).toEqual(["c", "d"]);
    expect(names(unobserve)).toEqual(["b"]);

    unmount();
    expect(names(unobserve).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("release now: a tuple dropped from the list is let go at once; unmounting keeps the keep-alive", () => {
    const d = descriptor();
    const client = makeClient();
    const { rerender, unmount } = renderHook(
      ({ list }: { list: { n: string }[] }) =>
        useResources(d, list, { release: "now" }),
      {
        wrapper: wrapperFor(client),
        initialProps: { list: [tuple("a"), tuple("b")] },
      },
    );
    const { unobserve } = spyNotifications();
    unobserve.mockClear();
    rerender({ list: [tuple("a")] });
    expect(
      unobserve.mock.calls.map((c) => [(c[1] as { n: string }).n, c[3]]),
    ).toEqual([["b", "now"]]);
    unmount();
    expect(
      unobserve.mock.calls.map((c) => [(c[1] as { n: string }).n, c[3]]),
    ).toEqual([
      ["b", "now"],
      ["a", undefined],
    ]);
  });

  it("each tuple carries where its value was last applied (appliedSeq)", async () => {
    const d = descriptor();
    const client = makeClient();
    const { result } = renderHook(
      () => useResources(d, [tuple("a"), tuple("b")]),
      { wrapper: wrapperFor(client) },
    );
    const { notifications } = spyNotifications();
    expect(result.current.map((r) => r.appliedSeq)).toEqual([0, 0]);
    vi.spyOn(notifications, "appliedSeq").mockImplementation((_key, params) =>
      (params as { n: string }).n === "a" ? 7 : 3,
    );
    act(() => {
      client.setQueryData(queryKeyFor(d.key, tuple("a")), [1]);
      client.setQueryData(queryKeyFor(d.key, tuple("b")), [2]);
    });
    await waitFor(() =>
      expect(result.current.map((r) => r.status)).toEqual(["ready", "ready"]),
    );
    expect(result.current.map((r) => r.appliedSeq)).toEqual([7, 3]);
  });

  it("shares a tuple's refcount with a useResource on the same tuple", () => {
    const d = descriptor();
    const client = makeClient();
    function Many({ list }: { list: { n: string }[] }) {
      useResources(d, list);
      return null;
    }
    function One() {
      useResource(d, tuple("a"));
      return null;
    }
    const wrapper = wrapperFor(client);
    const view = render(
      <>
        <Many list={[tuple("a"), tuple("b")]} />
        <One />
      </>,
      { wrapper },
    );
    const { notifications } = spyNotifications();
    const refcount = (n: string): number | undefined =>
      notifications
        .debugSnapshot()
        .subs.find((s) => s.key === d.key && s.paramsKey === `{"n":"${n}"}`)
        ?.refcount;
    expect(refcount("a")).toBe(2);
    expect(refcount("b")).toBe(1);

    // The list drops a: the single read keeps it subscribed.
    view.rerender(
      <>
        <Many list={[tuple("b")]} />
        <One />
      </>,
    );
    expect(refcount("a")).toBe(1);
    expect(refcount("b")).toBe(1);
  });

  it("each tuple is loading until its own value lands, and counts as a pending mount until then", async () => {
    const d = descriptor();
    const client = makeClient();
    const before = pendingMountSnapshot().pending;
    const { result } = renderHook(
      () => useResources(d, [tuple("a"), tuple("b")]),
      { wrapper: wrapperFor(client) },
    );
    spyNotifications();
    expect(result.current.map((r) => r.status)).toEqual(["loading", "loading"]);
    expect(pendingMountSnapshot().pending - before).toBe(2);

    act(() => {
      client.setQueryData(queryKeyFor(d.key, tuple("b")), [2]);
    });
    await waitFor(() =>
      expect(result.current.map((r) => r.status)).toEqual(["loading", "ready"]),
    );
    const b = result.current[1]!;
    if (b.status !== "ready") throw new Error("unreachable");
    expect(b.data).toEqual([2]);
    expect(pendingMountSnapshot().pending - before).toBe(1);
  });

  it("a kept tuple's data keeps its identity across a reorder, a grow and a shrink", async () => {
    const d = descriptor();
    const client = makeClient();
    client.setQueryData(queryKeyFor(d.key, tuple("a")), [1]);
    client.setQueryData(queryKeyFor(d.key, tuple("b")), [2]);
    const { result, rerender } = renderHook(
      ({ list }: { list: { n: string }[] }) => useResources(d, list),
      {
        wrapper: wrapperFor(client),
        initialProps: { list: [tuple("a"), tuple("b")] },
      },
    );
    spyNotifications();
    const dataOf = (i: number) => {
      const r = result.current[i]!;
      return r.status === "ready" ? r.data : undefined;
    };
    await waitFor(() => expect(dataOf(1)).toEqual([2]));
    const a = dataOf(0);
    const b = dataOf(1);
    // Reorder: positional sharing would merge a's data into b's slot.
    rerender({ list: [tuple("b"), tuple("a")] });
    expect(dataOf(0)).toBe(b);
    expect(dataOf(1)).toBe(a);
    // Grow before them, then shrink: still the cache's own objects.
    rerender({ list: [tuple("c"), tuple("b"), tuple("a")] });
    expect(result.current[0]!.status).toBe("loading");
    expect(dataOf(1)).toBe(b);
    expect(dataOf(2)).toBe(a);
    rerender({ list: [tuple("a")] });
    expect(dataOf(0)).toBe(a);
  });

  it("an unchanged tuple keeps its result object when another tuple changes", async () => {
    const d = descriptor();
    const client = makeClient();
    client.setQueryData(queryKeyFor(d.key, tuple("a")), [1]);
    client.setQueryData(queryKeyFor(d.key, tuple("b")), [2]);
    const { result } = renderHook(
      () => useResources(d, [tuple("a"), tuple("b")]),
      { wrapper: wrapperFor(client) },
    );
    spyNotifications();
    await waitFor(() => expect(result.current[1]!.status).toBe("ready"));
    const a = result.current[0]!;
    const b = result.current[1]!;
    act(() => {
      client.setQueryData(queryKeyFor(d.key, tuple("b")), [3]);
    });
    await waitFor(() => {
      const r = result.current[1]!;
      expect(r.status === "ready" ? r.data : undefined).toEqual([3]);
    });
    // a did not move: the same result, so the same `refetch`.
    expect(result.current[0]).toBe(a);
    expect(result.current[1]).not.toBe(b);
  });

  it("refetch starts a new read even while one is in flight", async () => {
    const d = descriptor();
    const client = makeClient();
    client.setQueryData(queryKeyFor(d.key, tuple("a")), [1]);
    const { result } = renderHook(() => useResources(d, [tuple("a")]), {
      wrapper: wrapperFor(client),
    });
    const { notifications } = spyNotifications();
    await waitFor(() => expect(result.current[0]!.status).toBe("ready"));
    let reads = 0;
    vi.spyOn(notifications, "fetchOverHttp").mockImplementation(() => {
      reads++;
      return new Promise(() => {});
    });
    void result.current[0]!.refetch();
    void result.current[0]!.refetch();
    await waitFor(() => expect(reads).toBe(2));
  });

  it("reports each tuple's mount→settle once, when its own value lands", async () => {
    const d = descriptor();
    const reports: SlowResourceInfo[] = [];
    slowResourceReportSink.register((r) => {
      if (r.key === d.key) reports.push(r);
    });
    try {
      const client = makeClient();
      const { result, rerender } = renderHook(
        () => useResources(d, [tuple("a"), tuple("b")]),
        { wrapper: wrapperFor(client) },
      );
      spyNotifications();
      expect(reports).toEqual([]);
      act(() => {
        client.setQueryData(queryKeyFor(d.key, tuple("b")), [2]);
      });
      await waitFor(() => expect(result.current[1]!.status).toBe("ready"));
      expect(reports.map((r) => r.params)).toEqual([tuple("b")]);
      act(() => {
        client.setQueryData(queryKeyFor(d.key, tuple("a")), [1]);
        client.setQueryData(queryKeyFor(d.key, tuple("b")), [3]);
      });
      await waitFor(() => expect(result.current[0]!.status).toBe("ready"));
      rerender();
      expect(reports.map((r) => r.params)).toEqual([tuple("b"), tuple("a")]);
      expect(reports.every((r) => r.durationMs >= 0)).toBe(true);
    } finally {
      slowResourceReportSink.register(null);
    }
  });
});
