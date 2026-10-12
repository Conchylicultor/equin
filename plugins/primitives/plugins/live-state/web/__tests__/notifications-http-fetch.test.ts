/**
 * NotificationsClient HTTP fetch-path hazard tests (Fix A/B/C/F). The REAL
 * client runs on a `createTransportHub()` with a scripted `fetchImpl` injected
 * through the constructor seam, so `fetchOverHttp`'s cache directive, the
 * epoch-aware version guard, the never-applied (unvouched) guard, and the
 * stale-drop report sink are exercised end-to-end. Only the three OS globals
 * (WebSocket/BroadcastChannel/navigator.locks) plus `fetch` are faked.
 *
 * Pins (Fix G list in
 * research/2026-07-15-global-live-state-http-cache-poisoning-class-fix.md):
 *   1. URL + `cache: "no-store"` on both fetches; `If-None-Match` iff `entry.etag`.
 *   2. 304 with an applied value → same reference, no write, no second fetch.
 *   3. 304 never-applied → second unconditional fetch, body applied.
 *   4. Same-epoch stale drop, applied → cached returned, sink `consecutiveDrops: 1`.
 *   5. Same-epoch stale drop, never-applied → throws `ResourceStaleReadError`.
 *   6. Equal-version same-epoch → applies (strict-`<` regression pin).
 *   7. Cross-epoch adopt (case 2) → applies, version+epoch adopted.
 *   8. Cross-epoch drop (case 3) → cached / throw; trace `stale-epoch`.
 *   9. Case 4 (no arbiter) → adopts.
 *  10. Consecutive-drop counter resets on apply; sink payload correct.
 *  11. Epoch-less body → today's strict-`<` behavior byte-for-byte.
 *
 * Conventions mirror the sibling suites: `clientLog` mocked to a no-op; fake
 * timers per test; every client `destroy()`-ed in afterEach; the module-level
 * stale-drop sink is registered per test and cleared in afterEach.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { z } from "zod";
import { toResourceError } from "../resource-error";
import {
  createTransportHub,
  type FakeWebSocket,
} from "@plugins/primitives/plugins/networking/web/testing";
import {
  NotificationsClient,
  ResourceHttpError,
  ResourceStaleReadError,
  isTerminalResourceError,
  queryKeyFor,
} from "../notifications-client";
import { renderHook } from "@testing-library/react";
import {
  BUILD_GRAPH_HEADER,
  resourceBytesHeaders,
} from "@plugins/packages/plugins/resource-protocol/core";
import {
  resetResourceContractMismatches,
  useResourceContractMismatches,
} from "../resource-contract-store";
import {
  httpStaleDropReportSink,
  type HttpStaleDropReport,
} from "../stale-drop-reporter";

const pushSchema = z.object({ status: z.string() });

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

interface ScriptedResponse {
  status?: number;
  ok?: boolean;
  body?: unknown;
  etag?: string | null;
}

/** A minimal Response-like: fetchOverHttp reads only status/ok/headers.get/json. */
function makeResponse(opts: ScriptedResponse): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "etag" ? (opts.etag ?? null) : null,
    },
    json: async () => opts.body,
  } as unknown as Response;
}

describe("NotificationsClient — HTTP fetch path", () => {
  const clients: NotificationsClient[] = [];
  let drops: HttpStaleDropReport[] = [];

  /** A fresh client whose worktree socket is elected + opened, with a scripted
   *  fetchImpl queue and a record of every call's (url, init). */
  async function setup(): Promise<{
    hub: ReturnType<typeof createTransportHub>;
    qc: QueryClient;
    client: NotificationsClient;
    socket: FakeWebSocket;
    fetchQueue: Response[];
    fetchCalls: Array<{ url: string; init?: RequestInit }>;
  }> {
    const hub = createTransportHub();
    const qc = new QueryClient();
    const tab = hub.tab();
    const fetchQueue: Response[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      fetchCalls.push({ url: String(url), init });
      const r = fetchQueue.shift();
      if (!r) throw new Error(`no scripted response for ${String(url)}`);
      return r;
    }) as typeof fetch;
    const client = new NotificationsClient(qc, {
      makeSocket: hub.makeSocket(tab),
      fetchImpl,
    });
    clients.push(client);
    await flush(); // elected → worktree socket created (connecting)
    const socket = hub.server.all()[0]!;
    socket.open(); // leader socket open
    return { hub, qc, client, socket, fetchQueue, fetchCalls };
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    drops = [];
    httpStaleDropReportSink.register((r) => {
      drops.push(r);
    });
  });

  afterEach(() => {
    httpStaleDropReportSink.register(null);
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("1: URL + cache:no-store on both fetches; If-None-Match iff entry.etag", async () => {
    const { client, qc, socket, fetchQueue, fetchCalls } = await setup();
    client.observe("k", { id: "c1" }, undefined, { schema: pushSchema });

    // No etag yet → no If-None-Match; cache:no-store; correct URL with params.
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "a" }, version: 1, epoch: "b1" },
      }),
    );
    await client.fetchOverHttp(
      "k",
      { id: "c1" },
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(fetchCalls[0]!.url).toBe("/api/resources/k?id=c1");
    expect(fetchCalls[0]!.init?.cache).toBe("no-store");
    expect(
      (fetchCalls[0]!.init?.headers as Record<string, string> | undefined)?.[
        "If-None-Match"
      ],
    ).toBeUndefined();
    expect(qc.getQueryData(queryKeyFor("k", { id: "c1" }))).toEqual({
      status: "a",
    });

    // A WS sub-ack stamps an etag; the next conditional GET sends If-None-Match.
    socket.serverSend({
      kind: "update",
      key: "k",
      params: { id: "c1" },
      value: { status: "b" },
      version: 2,
      etag: "etag-2",
    });
    await flush();
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "b" }, version: 2, epoch: "b1" },
      }),
    );
    await client.fetchOverHttp(
      "k",
      { id: "c1" },
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(fetchCalls[1]!.init?.cache).toBe("no-store");
    expect(
      (fetchCalls[1]!.init?.headers as Record<string, string>)["If-None-Match"],
    ).toBe("etag-2");
  });

  test("2: 304 with an applied value → same reference, no write, no second fetch", async () => {
    const { client, qc, socket, fetchQueue, fetchCalls } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v1" },
      version: 1,
      epoch: "b1",
      etag: "e1",
    });
    await flush();
    const cached = qc.getQueryData(queryKeyFor("k", {}));

    fetchQueue.push(makeResponse({ status: 304 }));
    const out = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(out).toBe(cached); // same reference
    expect(fetchCalls).toHaveLength(1); // no defensive refetch
    expect(drops).toHaveLength(0);
  });

  test("3: 304 never-applied → second unconditional fetch, body applied (vouched-not-defined guard pin)", async () => {
    const { client, qc, fetchQueue, fetchCalls } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    // A value is present in the cache but was never server-applied
    // (dataUpdatedAt held at epoch 0): the guard keys on "vouched", not
    // "defined", so it must not keep it.
    qc.setQueryData(
      queryKeyFor("k", {}),
      { status: "unvouched" },
      { updatedAt: 0 },
    );
    client.noteHttpEtag("k", {}, undefined, "e1"); // so the GET is conditional

    fetchQueue.push(makeResponse({ status: 304 }));
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "real" }, version: 1, epoch: "b1" },
      }),
    );
    const out = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );

    expect(fetchCalls).toHaveLength(2); // 304 fell through to the unconditional refetch
    expect(fetchCalls[1]!.init?.cache).toBe("no-store");
    expect(
      (fetchCalls[1]!.init?.headers as Record<string, string> | undefined)?.[
        "If-None-Match"
      ],
    ).toBeUndefined();
    expect(out).toEqual({ status: "real" });
    expect(qc.getQueryData(queryKeyFor("k", {}))).toEqual({ status: "real" });
  });

  test("4: same-epoch stale drop, applied → cached returned, sink emitted consecutiveDrops:1", async () => {
    const { client, qc, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v5" },
      version: 5,
      epoch: "b1",
    });
    await flush();
    const cached = qc.getQueryData(queryKeyFor("k", {}));

    fetchQueue.push(
      makeResponse({
        body: { value: { status: "v3-stale" }, version: 3, epoch: "b1" },
      }),
    );
    const out = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(out).toBe(cached); // kept the newer cached value
    expect(qc.getQueryData(queryKeyFor("k", {}))).toEqual({ status: "v5" });
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      key: "k",
      reason: "stale-version",
      consecutiveDrops: 1,
      bodyVersion: 3,
      haveVersion: 5,
      neverApplied: false,
      source: "fallback",
    });
  });

  test("5: same-epoch stale drop, never-applied → throws ResourceStaleReadError", async () => {
    const { client, qc, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    // A versioned entry whose cache holds NO server-vouched value. The vehicle is
    // React Query gc'ing the observer-less query out from under a live sub (the
    // real production state): apply a real sub-ack for the version+epoch, then
    // reset the entry to a never-applied value (`updatedAt: 0` — the same
    // idiom as case 3).
    //
    // Deliberately NOT via an `up-to-date` frame: a value-less ack may no longer
    // advance a never-applied entry's version (see handleServerMessage's
    // no-applied-value guard), so that state is now unreachable by construction.
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "gc'd" },
      version: 5,
      epoch: "b1",
    });
    await flush();
    qc.setQueryData(
      queryKeyFor("k", {}),
      { status: "unvouched" },
      { updatedAt: 0 },
    );

    fetchQueue.push(
      makeResponse({
        body: { value: { status: "v3-stale" }, version: 3, epoch: "b1" },
      }),
    );
    await expect(
      client.fetchOverHttp(
        "k",
        {},
        undefined,
        { schema: pushSchema },
        "fallback",
      ),
    ).rejects.toBeInstanceOf(ResourceStaleReadError);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      reason: "stale-version",
      neverApplied: true,
    });
  });

  test("6: equal-version same-epoch → applies (strict-< regression pin)", async () => {
    const { client, qc, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v5" },
      version: 5,
      epoch: "b1",
    });
    await flush();

    // GET reports the counter without bumping it — the invalidate-mode refetch
    // returns the SAME version. `<` accepts it.
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "v5-refetch" }, version: 5, epoch: "b1" },
      }),
    );
    const out = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(out).toEqual({ status: "v5-refetch" });
    expect(qc.getQueryData(queryKeyFor("k", {}))).toEqual({
      status: "v5-refetch",
    });
    expect(drops).toHaveLength(0);
  });

  test("7: cross-epoch adopt (case 2) → applies, version+epoch adopted", async () => {
    const { client, qc, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "old" },
      version: 5,
      epoch: "b1",
    });
    await flush();

    // Server restarts to b2: learn the new epoch via a second sub's ack, leaving
    // k's entry stamped at the stale b1.
    client.observe("other", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "other",
      params: {},
      value: { status: "x" },
      version: 1,
      epoch: "b2",
    });
    await flush();

    // The HTTP body carries the live b2 identity → adopt even though version 2 < 5.
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "new" }, version: 2, epoch: "b2" },
      }),
    );
    const out = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(out).toEqual({ status: "new" });
    expect(qc.getQueryData(queryKeyFor("k", {}))).toEqual({ status: "new" });
    expect(drops).toHaveLength(0);
    // version was adopted UNCONDITIONALLY to the body's 2 (old-boot 5 is meaningless).
    const sub = client.debugSnapshot().subs.find((s) => s.key === "k")!;
    expect(sub.version).toBe(2);
    // epoch adopted to b2: a subsequent same-epoch stale (version 1, b2) now drops.
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "stale" }, version: 1, epoch: "b2" },
      }),
    );
    const out2 = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(out2).toEqual({ status: "new" }); // kept
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      reason: "stale-version",
      bodyEpoch: "b2",
      entryEpoch: "b2",
    });
  });

  test("8: cross-epoch drop (case 3) → cached returned (applied) with reason stale-epoch", async () => {
    const { client, qc, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    // entry.epoch === serverEpoch === b1 (the live identity).
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "live" },
      version: 5,
      epoch: "b1",
    });
    await flush();
    const cached = qc.getQueryData(queryKeyFor("k", {}));

    // Body is from an OLDER boot b0 → the body is stale, not the entry → drop.
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "old-boot" }, version: 9, epoch: "b0" },
      }),
    );
    const out = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(out).toBe(cached);
    expect(qc.getQueryData(queryKeyFor("k", {}))).toEqual({ status: "live" });
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      reason: "stale-epoch",
      bodyEpoch: "b0",
      entryEpoch: "b1",
      serverEpoch: "b1",
    });
  });

  test("8b: cross-epoch drop (case 3) never-applied → throws with reason stale-epoch", async () => {
    const { client, qc, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    // Same gc'd-cache vehicle as case 5: the sub-ack stamps entry.epoch=b1=
    // serverEpoch and version 5, then the query is reset to a never-applied
    // value. (An `up-to-date` can no longer stamp a never-applied entry.)
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "gc'd" },
      version: 5,
      epoch: "b1",
    });
    await flush();
    qc.setQueryData(
      queryKeyFor("k", {}),
      { status: "unvouched" },
      { updatedAt: 0 },
    );

    fetchQueue.push(
      makeResponse({
        body: { value: { status: "old-boot" }, version: 9, epoch: "b0" },
      }),
    );
    await expect(
      client.fetchOverHttp(
        "k",
        {},
        undefined,
        { schema: pushSchema },
        "fallback",
      ),
    ).rejects.toMatchObject({
      reason: "stale-epoch",
    });
    expect(drops[0]).toMatchObject({
      reason: "stale-epoch",
      neverApplied: true,
    });
  });

  test("9: case 4 (no arbiter) → adopts the live response", async () => {
    const { client, qc, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "b1val" },
      version: 5,
      epoch: "b1",
    });
    await flush();
    // Move serverEpoch to b2 via another sub — k stays stamped b1.
    client.observe("other", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "other",
      params: {},
      value: { status: "x" },
      version: 1,
      epoch: "b2",
    });
    await flush();

    // Body epoch b3 matches NEITHER entry (b1) NOR serverEpoch (b2) → adopt.
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "b3val" }, version: 2, epoch: "b3" },
      }),
    );
    const out = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(out).toEqual({ status: "b3val" });
    expect(qc.getQueryData(queryKeyFor("k", {}))).toEqual({ status: "b3val" });
    expect(drops).toHaveLength(0);
  });

  test("10: the consecutive-drop counter resets on a successful apply; sink payload is complete", async () => {
    const { client, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v5" },
      version: 5,
      epoch: "b1",
    });
    await flush();

    // Two consecutive stale drops → counts 1, then 2.
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "s3" }, version: 3, epoch: "b1" },
      }),
    );
    await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "s4" }, version: 4, epoch: "b1" },
      }),
    );
    await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(drops.map((d) => d.consecutiveDrops)).toEqual([1, 2]);
    // The full payload is present and correct.
    expect(drops[1]).toEqual({
      key: "k",
      params: {},
      reason: "stale-version",
      consecutiveDrops: 2,
      bodyVersion: 4,
      haveVersion: 5,
      bodyEpoch: "b1",
      entryEpoch: "b1",
      serverEpoch: "b1",
      source: "fallback",
      neverApplied: false,
    });

    // A successful WS apply resets the counter — the next drop is back to 1.
    socket.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "v6" },
      version: 6,
      epoch: "b1",
    });
    await flush();
    fetchQueue.push(
      makeResponse({
        body: { value: { status: "s2" }, version: 2, epoch: "b1" },
      }),
    );
    await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(drops.at(-1)!.consecutiveDrops).toBe(1);
  });

  test("11: epoch-less body → strict-< behavior byte-for-byte (drop older, apply newer)", async () => {
    const { client, qc, socket, fetchQueue } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v5" },
      version: 5,
      epoch: "b1",
    });
    await flush();
    const cached = qc.getQueryData(queryKeyFor("k", {}));

    // Older, no epoch → dropped (kept cached), sink emitted.
    fetchQueue.push(
      makeResponse({ body: { value: { status: "v3" }, version: 3 } }),
    );
    const dropped = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(dropped).toBe(cached);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      reason: "stale-version",
      bodyEpoch: null,
    });

    // Newer, no epoch → applies.
    fetchQueue.push(
      makeResponse({ body: { value: { status: "v7" }, version: 7 } }),
    );
    const applied = await client.fetchOverHttp(
      "k",
      {},
      undefined,
      { schema: pushSchema },
      "fallback",
    );
    expect(applied).toEqual({ status: "v7" });
    expect(qc.getQueryData(queryKeyFor("k", {}))).toEqual({ status: "v7" });
  });

  // A sub-error reaches a query that has no value yet. `useResource` keeps a
  // pushed query disabled until its first value, and
  // `invalidateQueries` skips disabled queries, so the fallback read must be
  // run on the query directly: its outcome is the query's error state (or
  // heals it), never a read left `pending` with no error.
  describe("sub-error on a pushed query with no value yet", () => {
    async function observeDisabled() {
      const env = await setup();
      env.client.observe("nv", {}, undefined, { schema: pushSchema });
      // `useResource`'s options for a pushed descriptor.
      const observer = new QueryObserver(env.qc, {
        queryKey: queryKeyFor("nv", {}),
        queryFn: () =>
          env.client.fetchOverHttp(
            "nv",
            {},
            undefined,
            { schema: pushSchema },
            "fallback",
          ),
        enabled: (query) => query.state.data !== undefined,
      });
      const unsubscribe = observer.subscribe(() => {});
      return { ...env, unsubscribe };
    }

    test("a failing HTTP read becomes the query's error", async () => {
      const { qc, socket, fetchQueue, fetchCalls, unsubscribe } =
        await observeDisabled();
      fetchQueue.push(makeResponse({ status: 500 }));
      socket.serverSend({
        kind: "sub-error",
        key: "nv",
        params: {},
        reason: "loader-failed",
      });
      await flush();
      expect(fetchCalls.map((c) => c.url)).toEqual(["/api/resources/nv"]);
      expect(qc.getQueryState(queryKeyFor("nv", {}))?.error).toBeInstanceOf(
        ResourceHttpError,
      );
      unsubscribe();
    });

    test("a succeeding HTTP read heals it", async () => {
      const { qc, socket, fetchQueue, unsubscribe } = await observeDisabled();
      fetchQueue.push(
        makeResponse({ body: { value: { status: "ok" }, version: 1 } }),
      );
      socket.serverSend({
        kind: "sub-error",
        key: "nv",
        params: {},
        reason: "loader-failed",
      });
      await flush();
      expect(qc.getQueryData(queryKeyFor("nv", {}))).toEqual({ status: "ok" });
      expect(qc.getQueryState(queryKeyFor("nv", {}))?.error).toBeNull();
      unsubscribe();
    });
  });

  describe("typed refusals (contract mismatch)", () => {
    afterEach(() => {
      resetResourceContractMismatches();
      vi.unstubAllEnvs();
    });

    test("every read names this tab's build in the build-graph header", async () => {
      vi.stubEnv("VITE_BUILD_GRAPH", "graph-x");
      const { client, fetchQueue, fetchCalls } = await setup();
      client.observe("k", {}, undefined, { schema: pushSchema });
      fetchQueue.push(
        makeResponse({ body: { value: { status: "a" }, version: 1 } }),
      );
      await client.fetchOverHttp(
        "k",
        {},
        undefined,
        { schema: pushSchema },
        "fallback",
      );
      expect(
        (fetchCalls[0]!.init?.headers as Record<string, string>)[
          BUILD_GRAPH_HEADER
        ],
      ).toBe("graph-x");
    });

    test("a 409 body becomes a typed, terminal ResourceHttpError and marks the store", async () => {
      const { client, fetchQueue } = await setup();
      const store = renderHook(() => useResourceContractMismatches());
      client.observe("hist", {}, undefined, { schema: pushSchema });
      fetchQueue.push(
        makeResponse({
          status: 409,
          body: {
            reason: "contract-mismatch",
            verdict: "skew",
            detail: "params.limit is missing",
          },
        }),
      );
      let err: unknown;
      try {
        await client.fetchOverHttp(
          "hist",
          {},
          undefined,
          { schema: pushSchema },
          "fallback",
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ResourceHttpError);
      expect(err).toMatchObject({
        status: 409,
        reason: "contract-mismatch",
        verdict: "skew",
      });
      // `useResource` does not retry it: the same bundle is refused the same way.
      expect(isTerminalResourceError(err)).toBe(true);
      store.rerender();
      expect(store.result.current).toEqual([
        { key: "hist", reason: "contract-mismatch", verdict: "skew" },
      ]);
    });

    const metricRead = {
      schema: pushSchema,
      refusals: ["unknown-metric", "bad-range"],
    };

    test("a 422 refusal carries the server's declared code and message, is terminal, and marks nothing", async () => {
      const { client, fetchQueue } = await setup();
      const store = renderHook(() => useResourceContractMismatches());
      client.observe("k", {}, undefined, metricRead);
      fetchQueue.push(
        makeResponse({
          status: 422,
          body: {
            reason: "refused",
            code: "unknown-metric",
            detail: 'unknown metric "x"',
          },
        }),
      );
      let err: unknown;
      try {
        await client.fetchOverHttp("k", {}, undefined, metricRead, "fallback");
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        status: 422,
        reason: "refused",
        code: "unknown-metric",
        detail: 'unknown metric "x"',
      });
      expect(toResourceError(err)).toMatchObject({
        kind: "refused",
        code: "unknown-metric",
        message: 'unknown metric "x"',
      });
      expect(isTerminalResourceError(err)).toBe(true);
      store.rerender();
      expect(store.result.current).toEqual([]);
    });

    test.each([
      ["a code the read does not declare", { code: "gone" }],
      ["no code at all", {}],
    ])(
      "a refusal with %s is a contract mismatch: client-outdated, terminal, marked skew",
      async (_name, extra) => {
        const { client, fetchQueue } = await setup();
        const store = renderHook(() => useResourceContractMismatches());
        client.observe("k", {}, undefined, metricRead);
        fetchQueue.push(
          makeResponse({
            status: 422,
            body: { reason: "refused", detail: "it went away", ...extra },
          }),
        );
        let err: unknown;
        try {
          await client.fetchOverHttp(
            "k",
            {},
            undefined,
            metricRead,
            "fallback",
          );
        } catch (e) {
          err = e;
        }
        expect(err).toMatchObject({
          status: 422,
          reason: "contract-mismatch",
          verdict: "skew",
        });
        expect(toResourceError(err)).toMatchObject({
          kind: "client-outdated",
          code: undefined,
        });
        expect(isTerminalResourceError(err)).toBe(true);
        store.rerender();
        expect(store.result.current).toEqual([
          { key: "k", reason: "contract-mismatch", verdict: "skew" },
        ]);
      },
    );

    test("a read that declares no refusals takes every refusal as a contract mismatch", async () => {
      const { client, fetchQueue } = await setup();
      client.observe("k", {}, undefined, { schema: pushSchema });
      fetchQueue.push(
        makeResponse({
          status: 422,
          body: { reason: "refused", code: "unknown-metric", detail: "x" },
        }),
      );
      let err: unknown;
      try {
        await client.fetchOverHttp(
          "k",
          {},
          undefined,
          { schema: pushSchema },
          "fallback",
        );
      } catch (e) {
        err = e;
      }
      expect(toResourceError(err).kind).toBe("client-outdated");
    });

    test("a 500 loader failure stays retryable and marks nothing", async () => {
      const { client, fetchQueue } = await setup();
      const store = renderHook(() => useResourceContractMismatches());
      client.observe("k", {}, undefined, { schema: pushSchema });
      fetchQueue.push(
        makeResponse({ status: 500, body: { reason: "loader-failed" } }),
      );
      let err: unknown;
      try {
        await client.fetchOverHttp(
          "k",
          {},
          undefined,
          { schema: pushSchema },
          "fallback",
        );
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ status: 500, reason: "loader-failed" });
      expect(isTerminalResourceError(err)).toBe(false);
      store.rerender();
      expect(store.result.current).toEqual([]);
    });
  });

  describe("bytes reads (a `bytes: true` descriptor)", () => {
    const bytesRead = {
      schema: z.custom<ArrayBuffer>(
        (v) => Object.prototype.toString.call(v) === "[object ArrayBuffer]",
      ),
      bytes: true as const,
    };
    const bytesResponse = (bytes: number[], version: number, epoch: string) =>
      new Response(new Uint8Array(bytes), {
        headers: resourceBytesHeaders({ version, epoch }),
      });

    test("the body is the ArrayBuffer and the envelope comes from the headers", async () => {
      const { client, qc, fetchQueue } = await setup();
      client.observe("b", { p: "1" }, undefined, bytesRead);
      fetchQueue.push(bytesResponse([1, 2], 4, "b1"));
      const out = await client.fetchOverHttp(
        "b",
        { p: "1" },
        undefined,
        bytesRead,
        "fallback",
      );
      expect([...new Uint8Array(out)]).toEqual([1, 2]);
      expect(qc.getQueryData(queryKeyFor("b", { p: "1" }))).toBe(out);
    });

    test("the header version feeds the guard: a value-less sub-ack sets the floor, an older body is dropped", async () => {
      const { client, socket, fetchQueue } = await setup();
      client.observe("b", {}, undefined, bytesRead);
      socket.serverSend({
        kind: "sub-ack",
        key: "b",
        params: {},
        version: 5,
        epoch: "b1",
      });
      await flush();
      fetchQueue.push(bytesResponse([1], 3, "b1"));
      await expect(
        client.fetchOverHttp("b", {}, undefined, bytesRead, "fallback"),
      ).rejects.toBeInstanceOf(ResourceStaleReadError);
      fetchQueue.push(bytesResponse([2], 5, "b1"));
      const out = await client.fetchOverHttp(
        "b",
        {},
        undefined,
        bytesRead,
        "fallback",
      );
      expect([...new Uint8Array(out)]).toEqual([2]);
    });

    test("a value-less sub-ack invalidates the tuple (its value is read over HTTP)", async () => {
      const { client, qc, socket } = await setup();
      const invalidate = vi.spyOn(qc, "invalidateQueries");
      client.observe("b", { p: "1" }, undefined, bytesRead);
      socket.serverSend({
        kind: "sub-ack",
        key: "b",
        params: { p: "1" },
        version: 1,
        epoch: "b1",
      });
      await flush();
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeyFor("b", { p: "1" }),
      });
      expect(qc.getQueryData(queryKeyFor("b", { p: "1" }))).toBeUndefined();
    });

    test("a JSON answer to a bytes read throws rather than settling", async () => {
      const { client, fetchQueue } = await setup();
      client.observe("b", {}, undefined, bytesRead);
      fetchQueue.push(
        new Response(JSON.stringify({ value: 1, version: 1, epoch: "b1" }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await expect(
        client.fetchOverHttp("b", {}, undefined, bytesRead, "fallback"),
      ).rejects.toThrow(/content-type/);
    });
  });
});
