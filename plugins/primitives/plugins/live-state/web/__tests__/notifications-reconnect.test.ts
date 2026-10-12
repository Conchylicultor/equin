/**
 * NotificationsClient reconnect + resync hazard tests. The REAL client runs on a
 * `createTransportHub()`; the socket is dropped (`serverClose`), reconnected
 * through the SharedWebSocket backoff, and the client's `replaySubs` +
 * `probeMissedUpdates` recovery paths are exercised end-to-end. Only the three
 * OS globals are faked.
 *
 * Pins, cross-referencing the v3 mental-model doc §9 and
 * `research/2026-07-03-global-live-state-client-transport-harness.md`:
 *   - H1: frames lost during the reopen gap (a push to a closed socket is
 *     silently dropped) are recovered by the reconnect resubscribe converging to
 *     server truth — the replay is ONE `sub-batch` frame;
 *   - H1b: the batch echoes each sub's pre-reset version plus the channel's
 *     known server epoch, and resets every baseline at send time (the old
 *     per-sub stagger is gone — same-boot replays short-circuit server-side,
 *     post-restart replays are bounded by the server's read gate);
 *   - H2: a server restart resets the version counters — the replay echoes the
 *     OLD epoch, the server answers full sub-acks at LOWER versions, and they
 *     APPLY because the baselines were reset at batch-build time; the client
 *     then re-learns the new epoch for its next replay;
 *   - same-boot reconnect: an `up-to-date-batch` adopts versions while keeping
 *     every cached value — zero re-parses, zero cache writes;
 *   - H7: a lost intermediate level-state frame still converges on the next full
 *     frame, and `probeMissedUpdates` surfaces a silently-missed gap end-to-end
 *     over the batch replay path.
 *
 * Conventions: `clientLog` mocked to a no-op; fake timers per test; Math.random
 * pinned to 0.5 so the reconnect backoff delay is exactly the base (500ms); every
 * client `destroy()`-ed in afterEach (module-level buses shared across the file).
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
import { NotificationsClient } from "../notifications-client";

const pushSchema = z.object({ status: z.string() });

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

interface BatchEntry {
  id?: number;
  key: string;
  params: Record<string, string>;
  etag?: string;
  version?: number;
}

describe("NotificationsClient — reconnect + resync", () => {
  const clients: NotificationsClient[] = [];

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
    await flush(); // elected → worktree socket created (connecting)
    const socket = hub.server.all()[0]!;
    socket.open(); // leader socket open
    return { hub, qc, client, socket };
    await flush();
  }

  // The single connecting socket the SharedWebSocket just created for reconnect.
  const nextSocket = (
    hub: ReturnType<typeof createTransportHub>,
  ): FakeWebSocket => hub.server.all().find((s) => s.readyState === 0)!;
  const subFrames = (
    socket: FakeWebSocket,
    key?: string,
  ): Record<string, unknown>[] =>
    socket
      .sentJson()
      .filter((m) => m.op === "sub" && (key === undefined || m.key === key));
  const batchFrames = (
    socket: FakeWebSocket,
  ): Array<Record<string, unknown> & { entries: BatchEntry[] }> =>
    socket.sentJson().filter((m) => m.op === "sub-batch") as Array<
      Record<string, unknown> & { entries: BatchEntry[] }
    >;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // backoff delay = base·(0.5+0.5) = base
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("H1: frames lost during the reopen gap are recovered by one sub-batch replay converging", async () => {
    const { client, hub, socket, qc } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v1" },
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "v1" });

    // Socket drops; a v2 frame lands on the now-closed socket and is silently lost
    // (serverSend is guarded on OPEN — the exact reopen gap).
    socket.serverClose();
    await flush();
    socket.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "v2-lost" },
      version: 2,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "v1" }); // never delivered

    // Backoff reconnect (exactly 500ms), then a fresh socket. The replay is ONE
    // sub-batch frame sent synchronously on open.
    await vi.advanceTimersByTimeAsync(500);
    const socket2 = nextSocket(hub);
    socket2.open();
    await flush();
    const batches = batchFrames(socket2);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.entries.map((e) => e.key)).toEqual(["k"]);

    // The resync sub-ack at v3 converges the cache to server truth.
    socket2.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v3" },
      version: 3,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "v3" });
  });

  test("H1b: the replay is a single complete sub-batch with per-sub version echoes + the known epoch, baselines reset at send", async () => {
    const { client, hub, socket } = await setup();
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
    for (const k of keys)
      client.observe(k, {}, undefined, { schema: pushSchema });
    await flush();
    expect(subFrames(socket)).toHaveLength(8); // fresh observes are single subs

    // Ack each sub at its own version, carrying the boot epoch the client learns.
    for (const [i, k] of keys.entries()) {
      socket.serverSend({
        kind: "sub-ack",
        key: k,
        params: {},
        value: { status: k },
        version: i + 1,
        epoch: "boot-1",
      });
      await flush();
    }

    // Drop → reconnect → fresh socket; the open triggers ONE synchronous batch.
    socket.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const socket2 = nextSocket(hub);
    socket2.open();
    await flush();

    const batches = batchFrames(socket2);
    expect(batches).toHaveLength(1); // the whole set in one frame — no stagger
    const batch = batches[0]!;
    expect(batch.tabId).toBeTypeOf("string");
    expect(batch.epoch).toBe("boot-1"); // the channel's learned server epoch
    expect(batch.complete).toBe(true);
    expect(batch.entries).toHaveLength(8);
    keys.forEach((k, i) => {
      const entry = batch.entries.find((e) => e.key === k)!;
      expect(entry.version).toBe(i + 1); // pre-reset version echoed per sub
    });
    // Baselines were reset AT SEND: every sub sits at the -1 baseline now.
    for (const sub of client.debugSnapshot().subs) expect(sub.version).toBe(-1);
    expect(subFrames(socket2)).toHaveLength(0); // no per-sub resends
  });

  test("a replayed sub whose cached value was gc'd echoes NO version/etag, so the server cannot short-circuit it", async () => {
    // The sub outlives the cache entry: React Query gc's an observer-less query
    // after gcTime while the sub lives on in `channel.subs` (a boot-hydrated
    // config for an app the user has not opened yet is exactly that). Echoing a
    // version/etag we can no longer back would buy an `up-to-date` carrying no
    // value — a wedge no later frame heals for a resource whose version never
    // moves. `kept` is the control: same replay, value still cached.
    const { client, hub, socket, qc } = await setup();
    for (const k of ["gcd", "kept"])
      client.observe(k, {}, undefined, { schema: pushSchema });
    await flush();
    for (const k of ["gcd", "kept"]) {
      socket.serverSend({
        kind: "sub-ack",
        key: k,
        params: {},
        value: { status: k },
        version: 4,
        epoch: "boot-1",
        etag: `e-${k}`,
      });
      await flush();
    }
    qc.removeQueries({ queryKey: ["gcd"] }); // gcTime elapsed for the unobserved query

    socket.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const socket2 = nextSocket(hub);
    socket2.open();
    await flush();

    const batch = batchFrames(socket2)[0]!;
    const gcd = batch.entries.find((e) => e.key === "gcd")!;
    expect(gcd.version).toBeUndefined(); // unbacked → no freshness claim
    expect(gcd.etag).toBeUndefined();
    const kept = batch.entries.find((e) => e.key === "kept")!;
    expect(kept.version).toBe(4); // backed → short-circuit still available
    expect(kept.etag).toBe("e-kept");

    // The full-path sub-ack the omission forces lands the value back.
    socket2.serverSend({
      kind: "sub-ack",
      key: "gcd",
      params: {},
      value: { status: "refetched" },
      version: 4,
      epoch: "boot-1",
    });
    await flush();
    expect(qc.getQueryData(["gcd"])).toEqual({ status: "refetched" });
  });

  test("H2: a server restart resets version counters — the batch echoes the OLD epoch, lower-version sub-acks APPLY, and the new epoch is re-learned", async () => {
    const { client, hub, socket, qc } = await setup();
    const keys = ["k0", "k1", "k2"];
    for (const k of keys)
      client.observe(k, {}, undefined, { schema: pushSchema });
    for (const k of keys) {
      socket.serverSend({
        kind: "sub-ack",
        key: k,
        params: {},
        value: { status: `${k}-old` },
        version: 5,
        epoch: "boot-1",
      });
      await flush();
    }
    expect(qc.getQueryData(["k0"])).toEqual({ status: "k0-old" });

    // Backend restart drops the socket; reconnect + open triggers the replay.
    hub.server.restart();
    await vi.advanceTimersByTimeAsync(500);
    const socket2 = nextSocket(hub);
    socket2.open();
    await flush();

    // The batch can only echo the OLD epoch (the client hasn't heard from the
    // new boot yet) — so the server takes the full path for every entry.
    const batch = batchFrames(socket2)[0]!;
    expect(batch.epoch).toBe("boot-1");
    for (const e of batch.entries) expect(e.version).toBe(5);

    // Post-restart sub-acks at the LOWER version 1 still apply: the batch build
    // reset every baseline to -1.
    for (const k of keys) {
      socket2.serverSend({
        kind: "sub-ack",
        key: k,
        params: {},
        value: { status: `${k}-new` },
        version: 1,
        epoch: "boot-2",
      });
      await flush();
    }
    expect(qc.getQueryData(["k0"])).toEqual({ status: "k0-new" });
    expect(qc.getQueryData(["k2"])).toEqual({ status: "k2-new" });

    // The client re-learned the new boot's epoch: the NEXT replay echoes it.
    socket2.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const socket3 = nextSocket(hub);
    socket3.open();
    await flush();
    expect(batchFrames(socket3)[0]!.epoch).toBe("boot-2");
  });

  test("same-boot reconnect: an up-to-date-batch adopts versions and keeps every cached value", async () => {
    const { client, hub, socket, qc } = await setup();
    for (const k of ["a", "b"]) {
      client.observe(k, {}, undefined, { schema: pushSchema });
      await flush();
      socket.serverSend({
        kind: "sub-ack",
        key: k,
        params: {},
        value: { status: `${k}-v1` },
        version: 1,
        epoch: "boot-1",
      });
      await flush();
    }
    const cachedA = qc.getQueryData(["a"]);

    // Drop + reconnect within the SAME server boot: the batch echoes (epoch,
    // version) and the server answers everything in one up-to-date-batch.
    socket.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const socket2 = nextSocket(hub);
    socket2.open();
    await flush();
    const batch = batchFrames(socket2)[0]!;
    expect(batch.epoch).toBe("boot-1");

    socket2.serverSend({
      kind: "up-to-date-batch",
      epoch: "boot-1",
      entries: [
        { key: "a", params: {}, version: 1 },
        { key: "b", params: {}, version: 1 },
      ],
    });
    await flush();

    // Caches untouched — the exact same object reference survives.
    expect(qc.getQueryData(["a"])).toBe(cachedA);
    expect(qc.getQueryData(["b"])).toEqual({ status: "b-v1" });
    // Versions adopted: a stale replay of v1 is dropped, a genuine v2 applies.
    socket2.serverSend({
      kind: "update",
      key: "a",
      params: {},
      value: { status: "a-stale" },
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(["a"])).toBe(cachedA); // v1 ≤ adopted 1 → dropped
    socket2.serverSend({
      kind: "update",
      key: "a",
      params: {},
      value: { status: "a-v2" },
      version: 2,
    });
    await flush();
    expect(qc.getQueryData(["a"])).toEqual({ status: "a-v2" });
  });

  test("H7: a lost intermediate level-state frame still converges on the next full frame", async () => {
    const { client, socket, qc } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "working" },
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "working" });

    // The v2 frame never arrives (lost). Level state carries full truth, so the
    // next full frame at v3 converges — no replay of the missing intermediate.
    socket.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "gone" },
      version: 3,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "gone" });
  });

  test("H7: probeMissedUpdates surfaces a silently-missed gap end-to-end over the batch replay", async () => {
    const { client, socket, qc } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v1" },
      version: 1,
    });
    await flush();
    socket.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "v3" },
      version: 3,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "v3" });

    // Start the probe: it forces a resync via the SAME batch replay (the frame
    // is handed to the shared socket before the returned promise settles), then
    // awaits a fixed settle window for the acks.
    const probe = client.probeMissedUpdates(200);
    await flush();
    const batches = batchFrames(socket);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.entries.map((e) => e.key)).toEqual(["k"]);
    expect(batches[0]!.entries[0]!.version).toBe(3); // echoes the pre-reset baseline

    // The resync sub-ack reveals a higher server version — the missed frames —
    // landing BEFORE the settle window elapses.
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v9" },
      version: 9,
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "v9" }); // cache converged

    await vi.advanceTimersByTimeAsync(200); // settle elapses
    const missed = await probe;
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({
      key: "k",
      prevVersion: 3,
      ackVersion: 9,
    });
  });

  test("H7: a socket that reopens during the probe re-baselines — its higher sub-ack versions are never reported as missed", async () => {
    // Waking from sleep: the probe fires on visibilitychange while the socket
    // is (about to be) down. The server released the old socket's tuples, so on
    // the new socket every tuple opens a fresh tracking span at a HIGHER
    // version even though nothing changed — a re-baseline, not a dropped frame.
    const { client, hub, socket, qc } = await setup();
    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v1" },
      version: 1,
    });
    await flush();

    socket.serverClose();
    await flush();
    const probe = client.probeMissedUpdates(1_500);

    // The reconnect lands inside the settle window (backoff = 500ms here).
    await vi.advanceTimersByTimeAsync(500);
    const socket2 = nextSocket(hub);
    socket2.open();
    await flush();
    socket2.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v1" },
      version: 2, // the new span's version: nothing changed
    });
    await flush();
    expect(qc.getQueryData(["k"])).toEqual({ status: "v1" });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(await probe).toEqual([]);
  });
});
