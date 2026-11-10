/**
 * `include: "ancestors"` on a tree collection (`liveCollection(key, { tree })`):
 * the window read adds `ancestors` (each loaded page's `:ancestors` tuple,
 * seeded by the parents its rows do not hold, minus the rows the read holds)
 * and reads the window at exactly the plain read's tuple; the row read adds
 * the row's chain, root-first. Harness: a real NotificationsProvider +
 * QueryClient, values landed with `setQueryData` on the exact tuple (the call
 * a sub-ack makes), as in use-live-list.test.tsx.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import { act, renderHook, waitFor } from "@testing-library/react";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { queryKeyFor } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
  NotificationsClient,
} from "@plugins/network/plugins/live/plugins/live-state/web/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { mintVisibleRange } from "../internal/visible-range";

let seq = 0;
const tree = () =>
  liveCollection(`test.use-live-ancestors.${seq++}`, {
    fields: {
      id: textField({ label: "Id" }),
      parentId: nullable(textField({ label: "Parent" })),
      rank: textField({ label: "Rank" }),
    },
    id: "id",
    sortable: ["rank"],
    default: { orderBy: [["rank", "asc"]], limit: 10 },
    maxLimit: 20,
    tree: { parent: "parentId", rank: "rank" },
  });

const node = (id: string, parentId: string | null) => ({
  id,
  parentId,
  rank: id,
  $childCount: 0,
});

function mount<R>(live: LiveStateHarness, useHook: () => R) {
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  return renderHook(useHook, { wrapper: live.Wrapper });
}

describe('useLive(tree, { …, include: "ancestors" })', () => {
  it("a window read: the page's ancestors beside its rows, its window tuple the plain read's", async () => {
    const c = tree();
    const live = createLiveStateHarness();
    const observe = vi.spyOn(NotificationsClient.prototype, "observe");
    const { result } = mount(live, () => useLive(c, { include: "ancestors" }));
    // The window is read at the default tuple — `include` never reaches it.
    expect(
      observe.mock.calls.filter(([k]) => k === c.key).map(([, p]) => p),
    ).toEqual([c.window.defaultParams]);
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.key, c.window.defaultParams),
        [
          { ...node("x", "p"), $key: '["x","x"]' },
          { ...node("y", "x"), $key: '["y","y"]' },
        ],
      );
    });
    // The rows are known, their ancestors not yet: still loading.
    await waitFor(() =>
      expect(
        observe.mock.calls.filter(([k]) => k === c.ancestors.key).length,
      ).toBe(1),
    );
    expect(result.current.status).toBe("loading");
    // One tuple, seeded by the one parent the page does not hold.
    const params = c.ancestors.point.encode(["p"]);
    expect(
      observe.mock.calls.filter(([k]) => k === c.ancestors.key)[0]![1],
    ).toEqual(params);
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(c.ancestors.key, params), [
        node("q", null),
        node("p", "q"),
      ]);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("not ready");
    expect(r.data.map((row) => row.id)).toEqual(["x", "y"]);
    expect(r.ancestors.map((row) => row.id).sort()).toEqual(["p", "q"]);
    expect(r.ancestorsPending).toBe(false);

    // The page's rows move under another parent: a new seed set, with no
    // answer yet. The read stays ready (paging never flips back), flagged
    // pending, and never shows the old seeds' answer as the new one's.
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.key, c.window.defaultParams),
        [{ ...node("x", "m"), $key: '["x","x"]' }],
      );
    });
    await waitFor(() => {
      const moved = result.current;
      if (moved.status !== "ready") throw new Error(moved.status);
      expect(moved.data.map((row) => row.parentId)).toEqual(["m"]);
    });
    const moved = result.current;
    if (moved.status !== "ready") throw new Error("not ready");
    expect(moved.ancestorsPending).toBe(true);
    expect(moved.ancestors).toEqual([]);
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.ancestors.key, c.ancestors.point.encode(["m"])),
        [node("m", null)],
      );
    });
    await waitFor(() => {
      const settled = result.current;
      if (settled.status !== "ready") throw new Error(settled.status);
      expect(settled.ancestorsPending).toBe(false);
      expect(settled.ancestors.map((row) => row.id)).toEqual(["m"]);
    });
    observe.mockRestore();
  });

  it("a row read: the row and its chain, root-first; a root has none", async () => {
    const c = tree();
    const live = createLiveStateHarness();
    const { result } = mount(live, () =>
      useLive(c, { id: "c", include: "ancestors" }),
    );
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.rows.key, c.rows.point.encode(["c"])),
        [node("c", "b")],
      );
    });
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.ancestors.key, c.ancestors.point.encode(["b"])),
        [node("b", "a"), node("a", null)],
      );
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready" || !r.found) throw new Error("not found");
    expect(r.row.id).toBe("c");
    expect(r.ancestors.map((row) => row.id)).toEqual(["a", "b"]);

    // Re-parented b → z: its chain is not known until z's tuple answers —
    // `loading`, never `ready` with an empty (root-looking) chain.
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.rows.key, c.rows.point.encode(["c"])),
        [node("c", "z")],
      );
    });
    await waitFor(() => expect(result.current.status).toBe("loading"));
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.ancestors.key, c.ancestors.point.encode(["z"])),
        [node("z", "a"), node("a", null)],
      );
    });
    await waitFor(() => {
      const moved = result.current;
      if (moved.status !== "ready" || !moved.found)
        throw new Error("not found");
      expect(moved.ancestors.map((row) => row.id)).toEqual(["a", "z"]);
    });

    const root = mount(live, () =>
      useLive(c, { id: "a", include: "ancestors" }),
    );
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.rows.key, c.rows.point.encode(["a"])),
        [node("a", null)],
      );
    });
    await waitFor(() => expect(root.result.current.status).toBe("ready"));
    const a = root.result.current;
    if (a.status !== "ready") throw new Error("not ready");
    expect(a.ancestors).toEqual([]);
  });

  it("a viewport read is one read whether it asks for ancestors or reads nothing — a call site may flip between them", async () => {
    // A live tree's hits read: detached (`null` query) while the tree is in
    // expand mode, then asking with ancestors, then without, then detached
    // again — one call site, so one set of hooks throughout.
    const c = tree();
    const live = createLiveStateHarness();
    const viewport = mintVisibleRange({ kind: "measuring" });
    type Q = { include?: "ancestors" } | null;
    vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
    const { result, rerender } = renderHook(
      (p: { q: Q }) => useLive(c, p.q, { viewport }),
      { wrapper: live.Wrapper, initialProps: { q: null as Q } },
    );
    expect(result.current.status).toBe("loading");

    rerender({ q: { include: "ancestors" } });
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.key, c.window.defaultParams),
        [{ ...node("x", "p"), $key: '["x","x"]' }],
      );
      live.queryClient.setQueryData(
        queryKeyFor(c.ancestors.key, c.ancestors.point.encode(["p"])),
        [node("p", null)],
      );
    });
    await waitFor(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error(r.status);
      expect("ancestors" in r && r.ancestors.map((row) => row.id)).toEqual([
        "p",
      ]);
    });

    // Not asked: the same rows, no ancestors read.
    rerender({ q: {} });
    await waitFor(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error(r.status);
      expect(r.rows.map((row) => row.id)).toEqual(["x"]);
      expect("ancestors" in r).toBe(false);
    });

    // Detached, the page is released; asking again reads it (and its
    // ancestors) anew — landed again here, as the server's sub-acks would.
    rerender({ q: null });
    rerender({ q: { include: "ancestors" } });
    act(() => {
      live.queryClient.setQueryData(
        queryKeyFor(c.key, c.window.defaultParams),
        [{ ...node("x", "p"), $key: '["x","x"]' }],
      );
      live.queryClient.setQueryData(
        queryKeyFor(c.ancestors.key, c.ancestors.point.encode(["p"])),
        [node("p", null)],
      );
    });
    await waitFor(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error(r.status);
      expect("ancestors" in r && r.ancestors.map((row) => row.id)).toEqual([
        "p",
      ]);
    });
  });

  it("refuses `include` on a collection that is no tree", () => {
    const plain = liveCollection(`test.use-live-ancestors.${seq++}`, {
      fields: { id: textField({ label: "Id" }) },
      id: "id",
      sortable: ["id"],
      default: { orderBy: [["id", "asc"]], limit: 10 },
      maxLimit: 20,
    });
    const live = createLiveStateHarness();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      mount(live, () => useLive(plain, { include: "ancestors" } as never)),
    ).toThrow(/is not declared `tree`/);
  });
});
