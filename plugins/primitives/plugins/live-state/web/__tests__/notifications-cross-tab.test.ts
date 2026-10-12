/**
 * NotificationsClient cross-tab hazard tests (H6, full stack). TWO real
 * NotificationsClients (own QueryClient each) share one `createTransportHub()`
 * as two browser tabs attached to the same SharedWorker, which owns the only
 * real socket. The REAL tab client and worker host run; only the OS globals
 * are faked.
 *
 * Pins, cross-referencing `research/2026-10-08-networking-shared-worker-transport.md`:
 *   - H6: both tabs' subs ride the one socket; a tab dying (no pagehide) leaves
 *     the other on the SAME live socket with no reconnect and no replay, and the
 *     dead tab's `unsub-tab` will releases its subs on the server;
 *   - H6b: with both tabs subscribed to the same key, one server frame reaches
 *     BOTH clients' caches (the worker fans every frame out).
 *
 * Conventions: `clientLog` mocked to a no-op; fake timers per test; Math.random
 * pinned to 0.5; every client `destroy()`-ed in afterEach (module-level buses
 * shared across the file).
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
  type TabHandle,
} from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient } from "../notifications-client";

const pushSchema = z.object({ status: z.string() });

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

interface TwoTabs {
  hub: ReturnType<typeof createTransportHub>;
  qcA: QueryClient;
  qcB: QueryClient;
  clientA: NotificationsClient;
  clientB: NotificationsClient;
  tabA: TabHandle;
  s1: FakeWebSocket;
}

describe("NotificationsClient — cross-tab (H6)", () => {
  const clients: NotificationsClient[] = [];

  // A and B attached to the shared worker, socket S1 open.
  async function elect(): Promise<TwoTabs> {
    const hub = createTransportHub();
    const qcA = new QueryClient();
    const qcB = new QueryClient();
    const tabA = hub.tab();
    const clientA = new NotificationsClient(qcA, {
      makeSocket: hub.makeSocket(tabA),
      tabId: "tab-A",
    });
    clients.push(clientA);
    await flush(); // A attached → S1 connecting
    const s1 = hub.server.all()[0]!;
    s1.open();
    await flush();

    const tabB = hub.tab();
    const clientB = new NotificationsClient(qcB, {
      makeSocket: hub.makeSocket(tabB),
      tabId: "tab-B",
    });
    clients.push(clientB);
    await flush(); // B attached to the same open S1
    return { hub, qcA, qcB, clientA, clientB, tabA, s1 };
  }

  const subFrames = (
    socket: FakeWebSocket,
    key: string,
  ): Record<string, unknown>[] =>
    socket.sentJson().filter((m) => m.op === "sub" && m.key === key);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("H6: a tab dying leaves the other on the same live socket; its will releases its subs", async () => {
    const { hub, qcB, clientA, clientB, tabA, s1 } = await elect();
    expect(clientB.debugSnapshot().transport.worktree.attachedTabs).toBe(2);

    clientA.observe("k", {}, undefined, { schema: pushSchema });
    clientB.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    expect(subFrames(s1, "k")).toHaveLength(2); // both tabs' subs on S1
    s1.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "a" },
      version: 1,
    });
    await flush();
    expect(qcB.getQueryData(["k"])).toEqual({ status: "a" });

    hub.kill(tabA); // crash: no pagehide, the browser frees A's locks
    await flush();
    expect(s1.sentJson().filter((m) => m.op === "unsub-tab")).toEqual([
      { op: "unsub-tab", tabId: "tab-A" },
    ]);
    expect(hub.server.all()).toEqual([s1]); // no reconnect, no second socket
    expect(clientB.getStatus()).toBe("open");
    expect(s1.sentJson().filter((m) => m.op === "sub-batch")).toHaveLength(0); // no replay
    expect(clientB.debugSnapshot().transport.worktree.attachedTabs).toBe(1);

    s1.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "b" },
      version: 2,
    });
    await flush();
    expect(qcB.getQueryData(["k"])).toEqual({ status: "b" });
  });

  test("reconnect: two tabs replay independently-scoped batches — neither clobbers the other", async () => {
    // Each tab replays ONLY its own sub set, tagged with its own tabId, in its
    // own `sub-batch complete:true` frame — so the server's per-tab
    // reconciliation for tab A can never release tab B's subs.
    const hub = createTransportHub();
    const qcA = new QueryClient();
    const qcB = new QueryClient();
    const tabA = hub.tab();
    const clientA = new NotificationsClient(qcA, {
      makeSocket: hub.makeSocket(tabA),
      tabId: "tab-A",
    });
    clients.push(clientA);
    await flush();
    const s1 = hub.server.all()[0]!;
    s1.open();
    await flush();
    const tabB = hub.tab();
    const clientB = new NotificationsClient(qcB, {
      makeSocket: hub.makeSocket(tabB),
      tabId: "tab-B",
    });
    clients.push(clientB);
    await flush();

    clientA.observe("kA", {}, undefined, { schema: pushSchema });
    clientB.observe("kB", {}, undefined, { schema: pushSchema });
    await flush(); // both subs reach S1

    // Drop + reconnect: the worker reopens; the new connection makes BOTH
    // tabs replay, each its own batch.
    s1.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const s2 = hub.server.all().find((s) => s.readyState === 0)!;
    s2.open();
    await flush(); // deliver both tabs' batches

    const batches = s2.sentJson().filter((m) => m.op === "sub-batch") as Array<{
      tabId: string;
      complete: boolean;
      entries: Array<{ key: string }>;
    }>;
    expect(batches).toHaveLength(2); // one per tab — never a merged set
    const byTab = new Map(batches.map((b) => [b.tabId, b]));
    expect(byTab.get("tab-A")!.entries.map((e) => e.key)).toEqual(["kA"]);
    expect(byTab.get("tab-B")!.entries.map((e) => e.key)).toEqual(["kB"]);
    expect(byTab.get("tab-A")!.complete).toBe(true);
    expect(byTab.get("tab-B")!.complete).toBe(true);
  });

  test("a broadcast value-less `up-to-date` never poisons a tab holding no value — its own sub-ack still applies", async () => {
    // The fan-out H6b pins has a sharp edge: a value-less ack is meaningful ONLY
    // to the tab that asked. Tab A holds k at version 0 (a config-style resource
    // whose version never moves again); tab B then opens the same surface with a
    // fresh sub and an empty cache while A's replay is being answered.
    const { hub, qcA, qcB, clientA, clientB, s1 } = await elect();
    clientA.observe("k", {}, undefined, { schema: pushSchema });
    s1.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v0" },
      version: 0,
      epoch: "b1",
    });
    await flush(); // drain that ack's rx broadcast while B still holds no sub
    expect(qcB.getQueryData(["k"])).toBeUndefined();

    clientB.observe("k", {}, undefined, { schema: pushSchema });
    await flush(); // both subs reach S1; its ack is in flight
    expect(hub.server.openSockets()).toHaveLength(1);

    // A's replay echoed (epoch, version 0), so the server short-circuits with a
    // value-less `up-to-date` — broadcast to BOTH tabs. B holds a sub for k, so
    // the no-sub gate passes, but B has no value: it must NOT adopt version 0.
    s1.serverSend({
      kind: "up-to-date",
      key: "k",
      params: {},
      version: 0,
      epoch: "b1",
    });
    await flush();
    expect(qcB.getQueryData(["k"])).toBeUndefined();

    // B's own sub-ack arrives at the SAME version. Pre-fix B had already adopted
    // 0, so this was dropped as stale — and since a config version never moves
    // again, B stayed `pending` forever, rendering `descriptor.defaults` ("No
    // views configured") until a page reload.
    s1.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: { status: "v0" },
      version: 0,
      epoch: "b1",
    });
    await flush();
    expect(qcB.getQueryData(["k"])).toEqual({ status: "v0" });
    expect(qcA.getQueryData(["k"])).toEqual({ status: "v0" }); // A never lost its value
  });

  test("H6b: one server frame fans out to BOTH tabs' caches", async () => {
    const { hub, qcA, qcB, clientA, clientB, s1 } = await elect();
    // Both tabs subscribe k through the single shared socket.
    clientA.observe("k", {}, undefined, { schema: pushSchema });
    clientB.observe("k", {}, undefined, { schema: pushSchema });
    await flush(); // both subs reach S1
    expect(subFrames(s1, "k")).toHaveLength(2);
    expect(hub.server.openSockets()).toHaveLength(1);

    // ONE server frame on S1 reaches both caches through the worker's fan-out.
    s1.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "x" },
      version: 1,
    });
    await flush(); // deliver the fan-out
    expect(qcA.getQueryData(["k"])).toEqual({ status: "x" });
    expect(qcB.getQueryData(["k"])).toEqual({ status: "x" });
  });
});
