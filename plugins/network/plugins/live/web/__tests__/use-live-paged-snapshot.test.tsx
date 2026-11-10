/**
 * useLive over a paged value declared `load: "snapshot"` — an external source
 * with no change signal (a remote box read over SSH): key-range pages, each
 * read over HTTP when the read first needs it, `loadMore()` growing the read
 * as for any paged value, and `refresh()` re-measuring the pages it holds.
 *
 * The server half is the REAL compilation (`compilePagedValue` — the page
 * codec's decode, the range check, the `$key` mint): the HTTP read is stubbed
 * at the one HTTP path (`fetchOverHttp`) by running the compiled page loader
 * over the tuple asked, so the client cuts pages at keys the server minted.
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
import { z } from "zod";
import {
  createLiveStateHarness,
  NotificationsClient,
} from "@plugins/network/plugins/live/plugins/live-state/web/testing";
import {
  compilePagedValue,
  liveValue,
  sliceRange,
  type LivePagedParams,
} from "@plugins/network/plugins/live/core";
import { mintVisibleRange, useLive } from "@plugins/network/plugins/live/web";

const Visit = z.object({ id: z.string(), startedAt: z.string() });
type Visit = z.infer<typeof Visit>;
const Question = z.object({ site: z.string() });

let seq = 0;
const key = () => `test.use-live-paged-snapshot.${seq++}`;

/** A sessions-like value: visits newest first, keyed by (startedAt, id) desc. */
function sessions() {
  return liveValue(key(), {
    query: Question,
    paged: {
      item: Visit,
      id: "id",
      key: { of: (v) => [v.startedAt], order: ["desc"] },
      limit: 3,
      maxLimit: 6,
      meta: z.object({ total: z.number() }),
    },
    load: "snapshot",
  });
}

const visit = (i: number): Visit => ({
  id: `v${String(i).padStart(2, "0")}`,
  startedAt: `2026-11-10T10:${String(i).padStart(2, "0")}:00.000Z`,
});

/**
 * Serve `value` from `box()` — what the remote box holds right now — through
 * the real compiled page loader, counting each page read.
 */
function serve(value: ReturnType<typeof sessions>, box: () => Visit[]) {
  const compiled = compilePagedValue(value, {
    source: "external",
    changes: { snapshot: { reason: "a remote box with no change signal" } },
    loader: (_q, range) => sliceRange(value, box(), range),
    meta: () => ({ total: box().length }),
  });
  expect(compiled.snapshot).toBe(true);
  expect(compiled.options.mode).toBe("invalidate");
  const pageReads: LivePagedParams[] = [];
  const fetch = vi
    .spyOn(NotificationsClient.prototype, "fetchOverHttp")
    .mockImplementation(((k: string, params: Record<string, string>) => {
      if (k === value.key) {
        pageReads.push(params as LivePagedParams);
        return compiled.options.loader(params as LivePagedParams);
      }
      if (k === value.meta.key) {
        return compiled.meta!.options.loader(params as { q: string });
      }
      throw new Error(`unexpected read of ${k}`);
    }) as never);
  return { fetch, pageReads };
}

const ids = (rows: readonly Visit[]) => rows.map((r) => r.id);

describe("useLive — paged snapshot value", () => {
  it("reads page 0 over HTTP, grows by loadMore, and refresh() re-measures the pages held", async () => {
    const v = sessions();
    // Ten visits on the box, v09 the newest.
    let box = Array.from({ length: 10 }, (_, i) => visit(i));
    const { fetch, pageReads } = serve(v, () => box);
    const live = createLiveStateHarness();
    vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
    const { result } = renderHook(() => useLive(v, { site: "a" }), {
      wrapper: live.Wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const ready = () => {
      const r = result.current;
      if (r.status !== "ready") throw new Error(`not ready: ${r.status}`);
      return r;
    };
    // Page 0: the newest three, the one tuple a plain read names.
    expect(ids(ready().data)).toEqual(["v09", "v08", "v07"]);
    expect(pageReads).toHaveLength(1);
    expect(pageReads[0]).toEqual({ q: '{"site":"a"}', limit: "3" });
    expect(ready().canGrow).toBe(true);

    // Grows on demand: the next key range is measured when first needed.
    act(() => ready().loadMore());
    await waitFor(() =>
      expect(ids(ready().data)).toEqual([
        "v09",
        "v08",
        "v07",
        "v06",
        "v05",
        "v04",
      ]),
    );
    // Every page read carried a server-minted cut, never a cursor.
    for (const p of pageReads.slice(1)) {
      expect(p.after ?? p.until).toBeDefined();
    }

    // A new visit lands on the box; nothing tells a snapshot. Refresh
    // re-measures every page the read holds — the newest moves, older
    // ones (past the live cutoff) answer the same.
    box = [...box, visit(10)];
    const before = pageReads.length;
    await act(async () => {
      await result.current.refresh();
    });
    expect(pageReads.length).toBeGreaterThan(before);
    await waitFor(() => expect(ids(ready().data)[0]).toBe("v10"));
    expect(ids(ready().data)).toContain("v04");
    fetch.mockRestore();
  });

  it("under a viewport: pages and refresh() on every arm", async () => {
    const v = sessions();
    const box = Array.from({ length: 5 }, (_, i) => visit(i));
    const { fetch } = serve(v, () => box);
    const live = createLiveStateHarness();
    vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
    const { result } = renderHook(
      () =>
        useLive(
          v,
          { site: "a" },
          {
            viewport: mintVisibleRange({ kind: "measuring" }),
          },
        ),
      { wrapper: live.Wrapper },
    );
    expect(typeof result.current.refresh).toBe("function");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("not ready");
    expect(ids(r.rows)).toEqual(["v04", "v03", "v02"]);
    expect(r.canGrow).toBe(true);
    fetch.mockRestore();
  });

  it("the meta sibling is a snapshot read too", async () => {
    const v = sessions();
    const { fetch } = serve(v, () => [visit(0), visit(1)]);
    const live = createLiveStateHarness();
    vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
    const { result } = renderHook(() => useLive(v.meta, { site: "a" }), {
      wrapper: live.Wrapper,
    });
    await waitFor(() =>
      expect(result.current).toMatchObject({
        status: "ready",
        data: { total: 2 },
      }),
    );
    expect(typeof result.current.refresh).toBe("function");
    fetch.mockRestore();
  });

  it("types: refresh() only on a snapshot paged read", () => {
    const pushed = liveValue(key(), {
      query: Question,
      paged: {
        item: Visit,
        id: "id",
        key: { of: (x) => [x.startedAt], order: ["desc"] },
        limit: 3,
        maxLimit: 6,
      },
    });
    const snap = sessions();
    // Never called — the assertions are the types.
    const useTypeOnly = () => {
      void useLive(snap, { site: "a" }).refresh();
      // @ts-expect-error — a pushed paged value is kept live: nothing to refresh
      void useLive(pushed, { site: "a" }).refresh();
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});
