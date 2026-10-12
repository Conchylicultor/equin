/**
 * NotificationsClient subscription-lifecycle + frame-gate hazard tests. The REAL
 * client runs on a `createTransportHub()` (fake server + BroadcastChannel bus +
 * lock manager) wired through the `makeSocket` hook, so the version guard, keyed-
 * delta merge, keep-alive teardown timers, and etag recovery are all exercised
 * for real; only the three OS globals are faked.
 *
 * Pins, cross-referencing the v3 mental-model doc §9 and
 * `research/2026-07-03-global-live-state-client-transport-harness.md`:
 *   - H4: observe/unobserve churn inside the keep-alive window collapses to a
 *     single sub, and yields exactly one unsub once the window elapses;
 *   - H4b: the deferred-teardown timer fires only after the FULL window;
 *   - the no-sub gate: a broadcast frame for a never-observed key is dropped
 *     (no throw, no cache write) — the all-tabs fan-out safety;
 *   - delta-no-base → forced resub (etag cleared, cache untouched), and the
 *     BUG-A fix: the recovery resub carries NO version echo and its sub-ack
 *     APPLIES even at the version the broken delta already advanced us to
 *     (baselines reset in forceFullResub — without it the `<=` guard dropped
 *     the recovery ack and the cache never healed);
 *   - delta-drift → same forced-resub + recovery-applies contract;
 *   - the WS version guard (`<=` drop, `>` apply);
 *   - every sub/unsub frame carries this tab's id, and the tab's departure
 *     sends its `unsub-tab` last will per channel (the per-tab server bookkeeping).
 *
 * Conventions: `clientLog` is mocked to a no-op (otherwise `trace()` schedules
 * real fetch flushes and registers a permanent bus listener at module eval);
 * fake timers per test; advance only via the async variants; every constructed
 * client is `destroy()`-ed in afterEach (the module-level ws-status / net-diag
 * buses are shared across the file and cleaned only by proper teardown).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  createTransportHub,
  type FakeWebSocket,
} from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient, queryKeyFor } from "../notifications-client";
import { getResourceWatermark } from "../watermark-registry";
import { hasResourceTxAck } from "../tx-ack-registry";
import {
  resetResourceContractMismatches,
  useResourceContractMismatches,
} from "../resource-contract-store";
import { renderHook } from "@testing-library/react";

// SUB_KEEPALIVE_MS is not exported; keep the literal in sync with
// notifications-client.ts (the deferred-teardown gc window).
const SUB_KEEPALIVE_MS = 30_000;

const pushSchema = z.object({ status: z.string() });
const keyedSchema = z.array(
  z.object({ id: z.string(), n: z.number().optional() }),
);
const keyOf = (row: unknown): string => (row as { id: string }).id;

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — subs lifecycle + frame gates", () => {
  const clients: NotificationsClient[] = [];

  // A fresh client whose worktree socket is elected + opened (no subs yet).
  async function setup(): Promise<{
    hub: ReturnType<typeof createTransportHub>;
    qc: QueryClient;
    client: NotificationsClient;
    socket: FakeWebSocket;
  }> {
    const hub = createTransportHub();
    const qc = new QueryClient();
    const tab = hub.tab();
    const client = new NotificationsClient(qc, {
      makeSocket: hub.makeSocket(tab),
    });
    clients.push(client);
    await flush(); // elected → startLeading → worktree socket created (connecting)
    const socket = hub.server.all()[0]!;
    socket.open(); // leader socket open → replaySubs (no subs yet)
    return { hub, qc, client, socket };
    await flush();
  }

  const subFrames = (
    socket: FakeWebSocket,
    key?: string,
  ): Record<string, unknown>[] =>
    socket
      .sentJson()
      .filter((m) => m.op === "sub" && (key === undefined || m.key === key));
  const unsubFrames = (socket: FakeWebSocket): Record<string, unknown>[] =>
    socket.sentJson().filter((m) => m.op === "unsub");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("H4: observe/unobserve ×10 collapses to exactly one sub; one unsub after the keep-alive window", async () => {
    const { client, socket } = await setup();
    for (let i = 0; i < 10; i++) {
      client.observe("k", {}, undefined, { schema: pushSchema });
      client.unobserve("k", {});
      await flush();
    }
    // Only the first observe (refcount 0→1) hit the wire; every later observe
    // resurrected the refcount-0 sub inside its keep-alive window with zero WS
    // traffic, and the intervening unobserves only re-armed the teardown timer.
    expect(subFrames(socket)).toHaveLength(1);
    expect(unsubFrames(socket)).toHaveLength(0); // parked teardown, not yet fired

    await vi.advanceTimersByTimeAsync(SUB_KEEPALIVE_MS + 1);
    expect(unsubFrames(socket)).toHaveLength(1); // the one-shot teardown fired
    expect(client.debugSnapshot().subs).toHaveLength(0);
  });

  test("H4b: the keep-alive teardown fires only after the FULL window", async () => {
    const { client, socket } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    client.unobserve("k", {});
    await flush();

    // One tick short of the window: no unsub, sub still present.
    await vi.advanceTimersByTimeAsync(SUB_KEEPALIVE_MS - 1);
    expect(unsubFrames(socket)).toHaveLength(0);
    expect(client.debugSnapshot().subs).toHaveLength(1);

    // Crossing the window fires the teardown and deletes the sub.
    await vi.advanceTimersByTimeAsync(2);
    expect(unsubFrames(socket)).toHaveLength(1);
    expect(client.debugSnapshot().subs).toHaveLength(0);
  });

  test("release now: the last observer leaving with `now` unsubscribes at once, drops the cached value, and a remount is a new sub", async () => {
    const { client, socket, qc } = await setup();
    client.observe("k", { a: "1" }, undefined, { schema: pushSchema });
    client.observe("k", { a: "1" }, undefined, { schema: pushSchema });
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: { a: "1" },
      value: { status: "held" },
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(queryKeyFor("k", { a: "1" }))).toEqual({
      status: "held",
    });
    // Another observer still holds it: a refcount drop, no transition.
    client.unobserve("k", { a: "1" }, undefined, "now");
    await flush();
    expect(unsubFrames(socket)).toHaveLength(0);
    client.unobserve("k", { a: "1" }, undefined, "now");
    await flush();
    expect(unsubFrames(socket)).toHaveLength(1);
    expect(client.debugSnapshot().subs).toHaveLength(0);
    // Nothing keeps the cached value current any more: a remount reads
    // `loading` until the server vouches for one again.
    expect(qc.getQueryState(queryKeyFor("k", { a: "1" }))).toBeUndefined();
    // No parked teardown fires later.
    await vi.advanceTimersByTimeAsync(SUB_KEEPALIVE_MS + 1);
    expect(unsubFrames(socket)).toHaveLength(1);
    client.observe("k", { a: "1" }, undefined, { schema: pushSchema });
    await flush();
    expect(subFrames(socket, "k")).toHaveLength(2);
  });

  test("appliedSeq orders every sub's value on one client-wide sequence", async () => {
    const { client, socket } = await setup();
    client.observe("k", { a: "1" }, undefined, { schema: pushSchema });
    client.observe("k", { a: "2" }, undefined, { schema: pushSchema });
    await flush();
    expect(client.appliedSeq("k", { a: "1" })).toBe(0);
    const frame = (a: string, version: number) => ({
      kind: "sub-ack",
      key: "k",
      params: { a },
      value: { status: `v${version}` },
      version,
    });
    socket.serverSend(frame("2", 1));
    await flush();
    socket.serverSend(frame("1", 1));
    await flush();
    const one = client.appliedSeq("k", { a: "1" });
    const two = client.appliedSeq("k", { a: "2" });
    expect(one).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(0);
    socket.serverSend({ ...frame("2", 2), kind: "update" });
    await flush();
    expect(client.appliedSeq("k", { a: "2" })).toBeGreaterThan(one);
    // A tuple this tab holds no sub for has none.
    expect(client.appliedSeq("k", { a: "3" })).toBe(0);
  });

  test("no-sub gate: a frame for a never-observed key is dropped (no throw, no cache write)", async () => {
    const { client, socket, qc } = await setup();
    // The shared socket broadcasts every server frame to every tab; a tab that
    // never observed the key must silently drop it (no schema is registered, so
    // an ungated apply would throw).
    socket.serverSend({
      kind: "update",
      key: "ghost",
      params: {},
      value: { status: "x" },
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(["ghost"])).toBeUndefined();
    expect(client.debugSnapshot().subs).toHaveLength(0);
  });

  test("delta-no-base → forced resub: cache untouched, etag cleared, a version-less full sub sent, recovery ack at the SAME version applies (BUG A)", async () => {
    const { client, socket, qc } = await setup();
    client.observe("rk", {}, undefined, { schema: keyedSchema }, keyOf);
    await flush();
    // Stamp an etag on the sub with NO cached base (a sub whose value never
    // landed) so the recovery-clears-etag behavior is observable.
    client.noteHttpEtag("rk", {}, undefined, "etag-1");
    expect(client.etagFor("rk", {})).toBe("etag-1");
    const before = subFrames(socket, "rk").length;

    socket.serverSend({
      kind: "delta",
      key: "rk",
      params: {},
      upserts: [["a", { id: "a", n: 1 }]],
      deletes: [],
      order: ["a"],
      version: 1,
    });
    await flush();

    expect(qc.getQueryData(["rk"])).toBeUndefined(); // never applied onto a missing base
    expect(client.etagFor("rk", {})).toBeUndefined(); // stale etag cleared
    const after = subFrames(socket, "rk");
    expect(after).toHaveLength(before + 1); // forced full resub
    expect(after.at(-1)!.etag).toBeUndefined(); // the resub carries no stale etag
    expect(after.at(-1)!.version).toBeUndefined(); // and NO version echo (BUG A)

    // BUG A's fix: the broken delta already advanced the sub's version to 1, so
    // pre-fix the recovery sub-ack at that SAME version was `<=`-dropped and the
    // cache never healed. forceFullResub reset the baseline — it applies now.
    socket.serverSend({
      kind: "sub-ack",
      key: "rk",
      params: {},
      value: [{ id: "a", n: 1 }],
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(["rk"])).toEqual([{ id: "a", n: 1 }]); // healed
  });

  test("no vouched base: a scoped delta before this tab's sub-ack → forced resub, never a false partial list", async () => {
    const { client, socket, qc } = await setup();
    client.observe("rk", {}, undefined, { schema: keyedSchema }, keyOf);
    await flush();
    // Nothing server-vouched yet: the tuple's query holds no value.
    const before = subFrames(socket, "rk").length;

    // Another tab's subscription on the shared socket drew a SCOPED delta (no
    // `order`) for this tuple before this tab's own sub-ack landed.
    socket.serverSend({
      kind: "delta",
      key: "rk",
      params: {},
      upserts: [["a", { id: "a", n: 2 }]],
      deletes: [],
      version: 3,
    });
    await flush();
    expect(qc.getQueryState(["rk"])?.dataUpdatedAt ?? 0).toBe(0); // not settled on the delta
    expect(subFrames(socket, "rk")).toHaveLength(before + 1); // forced full resub

    // The recovery sub-ack applies (baselines reset), whatever this delta's version.
    socket.serverSend({
      kind: "sub-ack",
      key: "rk",
      params: {},
      value: [
        { id: "a", n: 2 },
        { id: "b", n: 1 },
      ],
      version: 3,
    });
    await flush();
    expect(qc.getQueryData(["rk"])).toEqual([
      { id: "a", n: 2 },
      { id: "b", n: 1 },
    ]);
  });

  test("delta-drift → forced resub: an order id resolvable from neither upserts nor base ⇒ cache unchanged, etag cleared, resub, recovery applies (BUG A)", async () => {
    const { client, socket, qc } = await setup();
    client.observe("rk", {}, undefined, { schema: keyedSchema }, keyOf);
    await flush();
    // Seed a base + etag via a full sub-ack.
    socket.serverSend({
      kind: "sub-ack",
      key: "rk",
      params: {},
      value: [{ id: "a", n: 1 }],
      version: 1,
      etag: "etag-a",
    });
    await flush();
    expect(qc.getQueryData(["rk"])).toEqual([{ id: "a", n: 1 }]);
    expect(client.etagFor("rk", {})).toBe("etag-a");
    const before = subFrames(socket, "rk").length;

    // order names "c" — in neither the upserts nor the cached base → drift.
    socket.serverSend({
      kind: "delta",
      key: "rk",
      params: {},
      upserts: [["b", { id: "b", n: 2 }]],
      deletes: [],
      order: ["a", "b", "c"],
      version: 2,
    });
    await flush();

    expect(qc.getQueryData(["rk"])).toEqual([{ id: "a", n: 1 }]); // untouched, no holes punched
    expect(client.etagFor("rk", {})).toBeUndefined(); // cleared → recovery reloads a full base
    const after = subFrames(socket, "rk");
    expect(after).toHaveLength(before + 1); // forced resub
    expect(after.at(-1)!.version).toBeUndefined(); // recovery never echoes state (BUG A)

    // The drift delta advanced the sub's version to 2 before drift was detected;
    // the recovery sub-ack at that SAME version must APPLY (baseline was reset).
    socket.serverSend({
      kind: "sub-ack",
      key: "rk",
      params: {},
      value: [
        { id: "a", n: 1 },
        { id: "b", n: 2 },
        { id: "c", n: 3 },
      ],
      version: 2,
    });
    await flush();
    expect(qc.getQueryData(["rk"])).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ]); // healed to server truth
  });

  test("every sub/unsub frame carries this tab's id; the tab's departure sends its unsub-tab will", async () => {
    const hub = createTransportHub();
    const qc = new QueryClient();
    const tab = hub.tab();
    const client = new NotificationsClient(qc, {
      makeSocket: hub.makeSocket(tab),
      tabId: "tab-X",
    });
    clients.push(client);
    await flush();
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();

    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    expect(subFrames(socket, "k")[0]!.tabId).toBe("tab-X");

    // The keep-alive teardown unsub is tagged too.
    client.unobserve("k", {});
    await vi.advanceTimersByTimeAsync(SUB_KEEPALIVE_MS + 1);
    expect(unsubFrames(socket)[0]!.tabId).toBe("tab-X");

    // pagehide → the worker sends this tab's will on every open channel.
    tab.lifecycle.hide(false);
    await flush();
    const departures = socket.sentJson().filter((m) => m.op === "unsub-tab");
    expect(departures).toHaveLength(1); // one open (worktree) channel
    expect(departures[0]!.tabId).toBe("tab-X");
  });

  test("the default holder id is per document, never the sessionStorage tab id an embedded frame shares", async () => {
    // A same-origin iframe of the app shares its host's sessionStorage — and so
    // `getTabId()`. Keyed by it, the frame's departing `unsub-tab` released every
    // sub the HOST held, freezing the host's live resources server-side.
    sessionStorage.setItem("singularity.tabId", "shared-with-embedded-frames");
    const hub = createTransportHub();
    const qc = new QueryClient();
    const tab = hub.tab();
    const client = new NotificationsClient(qc, {
      makeSocket: hub.makeSocket(tab),
    });
    clients.push(client);
    await flush();
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();

    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    const holder = subFrames(socket, "k")[0]!.tabId;
    expect(holder).toBeTypeOf("string");
    expect(holder).not.toBe("shared-with-embedded-frames");

    tab.lifecycle.hide(false);
    await flush();
    const departures = socket.sentJson().filter((m) => m.op === "unsub-tab");
    expect(departures[0]!.tabId).toBe(holder);
  });

  describe("client-requested acks (requestAcks)", () => {
    const subAcksFrames = (socket: FakeWebSocket): Record<string, unknown>[] =>
      socket.sentJson().filter((m) => m.op === "sub-acks");

    test("asked before the sub: the sub frame itself carries acks: true, no separate flip", async () => {
      const { client, socket } = await setup();
      const release = client.requestAcks("ak", { id: "1" });
      client.observe("ak", { id: "1" }, undefined, { schema: pushSchema });
      await flush();
      expect(subFrames(socket, "ak")[0]).toMatchObject({ acks: true });
      expect(subAcksFrames(socket)).toHaveLength(0);
      release();
      await flush();
      expect(subAcksFrames(socket)).toEqual([
        expect.objectContaining({
          key: "ak",
          params: { id: "1" },
          acks: false,
        }),
      ]);
    });

    test("OR across this tab's readers: one flip on at the first, one flip off after the last", async () => {
      const { client, socket } = await setup();
      client.observe("ak", {}, undefined, { schema: pushSchema });
      await flush();
      expect("acks" in subFrames(socket, "ak")[0]!).toBe(false);
      const a = client.requestAcks("ak", {});
      const b = client.requestAcks("ak", {});
      await flush();
      expect(subAcksFrames(socket)).toEqual([
        expect.objectContaining({
          key: "ak",
          acks: true,
          tabId: expect.any(String),
        }),
      ]);
      a();
      a(); // a release is idempotent — it never takes another reader's count
      await flush();
      expect(subAcksFrames(socket)).toHaveLength(1);
      b();
      await flush();
      expect(subAcksFrames(socket).at(-1)).toMatchObject({ acks: false });
      expect(subAcksFrames(socket)).toHaveLength(2);
    });

    test("a tuple's request never leaks onto another tuple's sub", async () => {
      const { client, socket } = await setup();
      client.requestAcks("ak", { id: "1" });
      client.observe("ak", { id: "2" }, undefined, { schema: pushSchema });
      await flush();
      expect("acks" in subFrames(socket, "ak")[0]!).toBe(false);
    });

    test("the reconnect replay restates the flag per entry", async () => {
      const { hub, client, socket } = await setup();
      client.observe("ak", {}, undefined, { schema: pushSchema });
      client.observe("plain", {}, undefined, { schema: pushSchema });
      client.requestAcks("ak", {});
      await flush();
      socket.serverClose();
      await vi.advanceTimersByTimeAsync(500);
      const socket2 = hub.server.all().find((s) => s.readyState === 0)!;
      socket2.open();
      await flush();
      const batch = socket2.sentJson().find((m) => m.op === "sub-batch") as {
        entries: Array<{ key: string; acks?: boolean }>;
      };
      expect(batch.entries.find((e) => e.key === "ak")?.acks).toBe(true);
      expect("acks" in batch.entries.find((e) => e.key === "plain")!).toBe(
        false,
      );
    });
  });

  test("version guard: a frame with version ≤ the applied version is dropped; a strictly-greater one applies", async () => {
    const { client, socket, qc } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "working" },
      version: 5,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "working" });

    // Equal version → dropped (the `<=` guard).
    socket.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "stale-equal" },
      version: 5,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "working" });

    // Lower version → dropped.
    socket.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "stale-lower" },
      version: 4,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "working" });

    // Strictly greater → applied.
    socket.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "fresh" },
      version: 6,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "fresh" });
  });

  // sub-error handling (Fix D): a sub-error names the (key, params) it failed
  // for, so the client runs the HTTP fallback read on exactly that query — its
  // outcome sets q.error / heals — instead of absorbing the frame and wedging
  // the resource pending forever. A direct fetch (`prefetchQuery`), not
  // `invalidateQueries`, which skips a disabled (valueless)
  // query — pinned end-to-end in notifications-http-fetch.test.ts. Gated on a
  // live local sub, like every other broadcast frame.
  test("sub-error with params for a held sub → fetches exactly that query key", async () => {
    const { client, socket, qc } = await setup();
    const fetchQuery = vi.spyOn(qc, "prefetchQuery").mockResolvedValue();
    client.observe("k", { id: "c1" }, undefined, { schema: pushSchema });
    await flush();

    socket.serverSend({
      kind: "sub-error",
      key: "k",
      params: { id: "c1" },
      reason: "loader-failed",
    });
    await flush();
    expect(fetchQuery).toHaveBeenCalledTimes(1);
    expect(fetchQuery.mock.calls[0]![0]).toMatchObject({
      queryKey: ["k", { id: "c1" }],
      staleTime: 0,
    });
  });

  test("sub-error for a non-held key → dropped, no fetch (broadcast-gate pin)", async () => {
    const { socket, qc } = await setup();
    const fetchQuery = vi.spyOn(qc, "prefetchQuery");
    // The shared socket broadcasts every frame to every tab; a tab that never
    // observed the key must not act on its sub-error.
    socket.serverSend({
      kind: "sub-error",
      key: "ghost",
      params: {},
      reason: "unknown-key",
    });
    await flush();
    expect(fetchQuery).not.toHaveBeenCalled();
  });

  // Contract mismatch: the server refused the sub because this bundle's params
  // do not match the declaration. The client records it for the Reload advice
  // and still heals through the one error channel (the HTTP refetch then gets
  // the typed 409 body).
  describe("contract-mismatch sub-error", () => {
    afterEach(() => resetResourceContractMismatches());

    test("marks the contract store with its verdict, then refetches as before", async () => {
      const { client, socket, qc } = await setup();
      const fetchQuery = vi.spyOn(qc, "prefetchQuery").mockResolvedValue();
      const store = renderHook(() => useResourceContractMismatches());
      client.observe("hist", { limit: "5" }, undefined, { schema: pushSchema });
      await flush();
      socket.serverSend({
        kind: "sub-error",
        key: "hist",
        params: { limit: "5" },
        reason: "contract-mismatch",
        verdict: "skew",
      });
      await flush();
      expect(fetchQuery).toHaveBeenCalledTimes(1);
      store.rerender();
      expect(store.result.current).toEqual([
        { key: "hist", reason: "contract-mismatch", verdict: "skew" },
      ]);
    });

    test("a loader-failed sub-error is the server's own failure: the store stays empty", async () => {
      const { client, socket } = await setup();
      const store = renderHook(() => useResourceContractMismatches());
      client.observe("k2", {}, undefined, { schema: pushSchema });
      await flush();
      socket.serverSend({
        kind: "sub-error",
        key: "k2",
        params: {},
        reason: "loader-failed",
      });
      await flush();
      store.rerender();
      expect(store.result.current).toEqual([]);
    });

    test("every sub and sub-batch frame names this tab's build", async () => {
      vi.stubEnv("VITE_BUILD_GRAPH", "graph-x");
      try {
        const { client, socket, hub } = await setup();
        client.observe("b1", {}, undefined, { schema: pushSchema });
        await flush();
        expect(subFrames(socket, "b1")[0]!.build).toBe("graph-x");
        // Reconnect → the replay is one sub-batch, which names the build too.
        socket.serverClose();
        await vi.advanceTimersByTimeAsync(500);
        const socket2 = hub.server.all().find((x) => x.readyState === 0)!;
        socket2.open();
        await flush();
        const batches = socket2.sentJson().filter((m) => m.op === "sub-batch");
        expect(batches).toHaveLength(1);
        expect(batches[0]!.build).toBe("graph-x");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  test("legacy params-less sub-error frame → dropped safely (no throw, no fetch)", async () => {
    const { client, socket, qc } = await setup();
    const fetchQuery = vi.spyOn(qc, "prefetchQuery");
    client.observe("k", { id: "c1" }, undefined, { schema: pushSchema });
    await flush();
    // A pre-upgrade server omits `params`; the client computes paramsKey({}) which
    // cannot match the non-empty-params sub → safe drop, never a throw.
    expect(() =>
      socket.serverSend({
        kind: "sub-error",
        key: "k",
        reason: "legacy",
      } as unknown as Record<string, unknown>),
    ).not.toThrow();
    await flush();
    expect(fetchQuery).not.toHaveBeenCalled();
  });

  // Commit-watermark adoption (Rule B′ client half). The registry is
  // MODULE-LEVEL (shared across tests in this process — that is the point: the
  // optimistic hook reads it without a NotificationsProvider), so each test
  // below uses its own resource key.
  describe("watermark registry adoption", () => {
    test("watermark-carrying frames populate the registry before the cache write; adoption is monotonic (BigInt, not string order)", async () => {
      const { socket, qc, client } = await setup();
      client.observe("wm-a", {}, undefined, { schema: pushSchema });
      await flush();

      // sub-ack carries the floor.
      socket.serverSend({
        kind: "sub-ack",
        key: "wm-a",
        params: {},
        value: { status: "s0" },
        version: 1,
        watermark: "100",
      });
      await flush();
      expect(qc.getQueryData(["wm-a"])).toEqual({ status: "s0" });
      expect(getResourceWatermark("wm-a", {})).toBe("100");

      // A newer-version frame carrying an OLDER watermark (a joiner-adopted
      // flight) applies its value but never regresses the floor.
      socket.serverSend({
        kind: "update",
        key: "wm-a",
        params: {},
        value: { status: "s1" },
        version: 2,
        watermark: "99",
      });
      await flush();
      expect(qc.getQueryData(["wm-a"])).toEqual({ status: "s1" });
      expect(getResourceWatermark("wm-a", {})).toBe("100");

      // Numeric (BigInt) adoption: "1000" > "999" even though "1000" < "999"
      // as strings.
      socket.serverSend({
        kind: "update",
        key: "wm-a",
        params: {},
        value: { status: "s2" },
        version: 3,
        watermark: "999",
      });
      await flush();
      socket.serverSend({
        kind: "update",
        key: "wm-a",
        params: {},
        value: { status: "s3" },
        version: 4,
        watermark: "1000",
      });
      await flush();
      expect(getResourceWatermark("wm-a", {})).toBe("1000");
    });

    test("a watermark-less scoped delta applies but leaves the stored floor untouched; a FULL delta's watermark adopts", async () => {
      const { socket, qc, client } = await setup();
      client.observe("wm-k", {}, undefined, { schema: keyedSchema }, keyOf);
      await flush();
      socket.serverSend({
        kind: "sub-ack",
        key: "wm-k",
        params: {},
        value: [{ id: "a", n: 1 }],
        version: 1,
        watermark: "200",
      });
      await flush();
      expect(getResourceWatermark("wm-k", {})).toBe("200");

      // Scoped delta (no order, no watermark — a partial re-read): value merges,
      // floor untouched.
      socket.serverSend({
        kind: "delta",
        key: "wm-k",
        params: {},
        upserts: [["a", { id: "a", n: 2 }]],
        deletes: [],
        version: 2,
      });
      await flush();
      expect(qc.getQueryData(["wm-k"])).toEqual([{ id: "a", n: 2 }]);
      expect(getResourceWatermark("wm-k", {})).toBe("200");

      // FULL keyed delta (order asserted, watermark carried): floor adopts.
      socket.serverSend({
        kind: "delta",
        key: "wm-k",
        params: {},
        upserts: [["b", { id: "b", n: 1 }]],
        deletes: [],
        order: ["a", "b"],
        version: 3,
        watermark: "201",
      });
      await flush();
      expect(qc.getQueryData(["wm-k"])).toEqual([
        { id: "a", n: 2 },
        { id: "b", n: 1 },
      ]);
      expect(getResourceWatermark("wm-k", {})).toBe("201");
    });

    test("a version-guard-dropped frame does NOT adopt its watermark", async () => {
      const { socket, qc, client } = await setup();
      client.observe("wm-d", {}, undefined, { schema: pushSchema });
      await flush();
      socket.serverSend({
        kind: "sub-ack",
        key: "wm-d",
        params: {},
        value: { status: "s0" },
        version: 5,
        watermark: "300",
      });
      await flush();
      expect(getResourceWatermark("wm-d", {})).toBe("300");

      // Equal version → `<=`-dropped: neither the cache nor the floor moves,
      // even though the frame claims a newer watermark.
      socket.serverSend({
        kind: "update",
        key: "wm-d",
        params: {},
        value: { status: "stale" },
        version: 5,
        watermark: "999",
      });
      await flush();
      expect(qc.getQueryData(["wm-d"])).toEqual({ status: "s0" });
      expect(getResourceWatermark("wm-d", {})).toBe("300");
    });

    test("a standalone ack frame is gated on the local sub; noted with NO version adoption and NO cache write", async () => {
      const { socket, qc, client } = await setup();
      client.observe("ack-a", {}, undefined, { schema: pushSchema });
      await flush();

      // Version-less standalone ack for a held sub: acks noted, nothing else —
      // the sub's version baseline stays -1 and the cache stays untouched.
      socket.serverSend({
        kind: "ack",
        key: "ack-a",
        params: {},
        ackTx: ["700", "701"],
      });
      await flush();
      expect(hasResourceTxAck("ack-a", {}, "700")).toBe(true);
      expect(hasResourceTxAck("ack-a", {}, "701")).toBe(true);
      expect(qc.getQueryData(["ack-a"])).toBeUndefined();
      expect(
        client.debugSnapshot().subs.find((s) => s.key === "ack-a")!.version,
      ).toBe(-1);

      // A never-observed key's ack is dropped by the broadcast gate (the shared
      // socket fans every frame to every tab).
      socket.serverSend({
        kind: "ack",
        key: "ack-ghost",
        params: {},
        ackTx: ["702"],
      });
      await flush();
      expect(hasResourceTxAck("ack-ghost", {}, "702")).toBe(false);
    });

    test("delta acks are noted BEFORE setQueryData — a QueryCache listener reads them synchronously", async () => {
      const { socket, qc, client } = await setup();
      client.observe("ack-k", {}, undefined, { schema: keyedSchema }, keyOf);
      await flush();
      socket.serverSend({
        kind: "sub-ack",
        key: "ack-k",
        params: {},
        value: [{ id: "a", n: 1 }],
        version: 1,
      });
      await flush();

      // The optimistic hook's confirm pass runs inside the QueryCache event —
      // the ack must already be readable there (same load-bearing order as the
      // watermark registry).
      const observed: boolean[] = [];
      const unsubscribe = qc.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        observed.push(hasResourceTxAck("ack-k", {}, "800"));
      });
      socket.serverSend({
        kind: "delta",
        key: "ack-k",
        params: {},
        upserts: [["a", { id: "a", n: 2 }]],
        deletes: [],
        version: 2,
        ackTx: ["800"],
      });
      await flush();
      unsubscribe();
      expect(qc.getQueryData(["ack-k"])).toEqual([{ id: "a", n: 2 }]);
      expect(observed).toContain(true);
      // An update frame's ackTx notes too.
      socket.serverSend({
        kind: "update",
        key: "ack-k",
        params: {},
        value: [{ id: "a", n: 3 }],
        version: 3,
        ackTx: ["801"],
      });
      await flush();
      expect(hasResourceTxAck("ack-k", {}, "801")).toBe(true);
    });

    test("a delta that dead-ends in a forced resub (no base) does NOT note its acks", async () => {
      const { socket, qc, client } = await setup();
      client.observe("ack-nb", {}, undefined, { schema: keyedSchema }, keyOf);
      await flush();

      // FULL delta with ackTx but no cached base: the client resubs and must
      // note NOTHING — the cache never received this truth, so confirming an op
      // against it would be a false ack. The recovery sub-ack's watermark is
      // the sanctioned confirmation path.
      socket.serverSend({
        kind: "delta",
        key: "ack-nb",
        params: {},
        upserts: [["a", { id: "a", n: 1 }]],
        deletes: [],
        order: ["a"],
        version: 1,
        ackTx: ["900"],
      });
      await flush();
      expect(qc.getQueryData(["ack-nb"])).toBeUndefined();
      expect(hasResourceTxAck("ack-nb", {}, "900")).toBe(false);
    });

    test("a delta that cannot apply (no base → forced resub) does NOT adopt its watermark", async () => {
      const { socket, qc, client } = await setup();
      client.observe("wm-nb", {}, undefined, { schema: keyedSchema }, keyOf);
      await flush();

      // FULL delta with a watermark but no cached base: the client resubs and
      // must NOT advance the floor — the cache never received this truth. The
      // recovery sub-ack carries its own watermark with its own full value.
      socket.serverSend({
        kind: "delta",
        key: "wm-nb",
        params: {},
        upserts: [["a", { id: "a", n: 1 }]],
        deletes: [],
        order: ["a"],
        version: 1,
        watermark: "400",
      });
      await flush();
      expect(qc.getQueryData(["wm-nb"])).toBeUndefined();
      expect(getResourceWatermark("wm-nb", {})).toBeUndefined();

      socket.serverSend({
        kind: "sub-ack",
        key: "wm-nb",
        params: {},
        value: [{ id: "a", n: 1 }],
        version: 1,
        watermark: "401",
      });
      await flush();
      expect(qc.getQueryData(["wm-nb"])).toEqual([{ id: "a", n: 1 }]);
      expect(getResourceWatermark("wm-nb", {})).toBe("401");
    });
  });
});
