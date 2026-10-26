/**
 * NotificationsClient — the server heartbeat's `pushStallMs`. The server's ping
 * reports how long the oldest change it owes has gone undelivered; a server whose
 * pushes stopped leaves the socket open and quiet, so the ping is the only sign
 * of it the tab gets. The client keeps the latest value
 * per channel in `ChannelStatuses.serverPushStallMs`, which the health report's
 * Connection row reads. See
 * `research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`.
 *
 * Pins:
 *   - a ping's `pushStallMs` lands in the channel status and notifies listeners;
 *   - a ping without it (a server that predates the field) reads as 0;
 *   - an unchanged value (an idle server's 0 → 0) notifies nobody;
 *   - every tab on the shared socket records it (the worker fans out every frame);
 *   - a socket drop clears it, so a restarted server's first quiet seconds are
 *     never reported as the dead server's stall.
 *
 * Conventions follow the sibling suites: `clientLog` mocked to a no-op, fake
 * timers per test, every client `destroy()`-ed in afterEach.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { QueryClient } from "@tanstack/react-query";
import {
  createTransportHub,
  type FakeWebSocket,
} from "@plugins/primitives/plugins/networking/web/testing";
import {
  NotificationsClient,
  type ChannelStatuses,
} from "../notifications-client";

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — heartbeat pushStallMs", () => {
  const clients: NotificationsClient[] = [];

  async function setup(): Promise<{
    hub: ReturnType<typeof createTransportHub>;
    client: NotificationsClient;
    socket: FakeWebSocket;
  }> {
    const hub = createTransportHub();
    const tab = hub.tab();
    const client = new NotificationsClient(new QueryClient(), {
      makeSocket: hub.makeSocket(tab),
    });
    clients.push(client);
    await flush(); // elected → worktree socket created (connecting)
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();
    return { hub, client, socket };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("starts at 0 on both channels", async () => {
    const { client } = await setup();
    expect(client.getChannelStatuses().serverPushStallMs).toEqual({
      worktree: 0,
      central: 0,
    });
  });

  test("a ping's pushStallMs lands in the channel status and notifies listeners", async () => {
    const { client, socket } = await setup();
    const seen: ChannelStatuses[] = [];
    client.subscribeChannelStatuses((s) => seen.push(s));
    seen.length = 0; // drop the synchronous initial call

    socket.serverSend({ kind: "ping", pushStallMs: 45_000 });
    await flush();
    expect(client.getChannelStatuses().serverPushStallMs.worktree).toBe(45_000);
    expect(client.getChannelStatuses().worktree).toBe("open");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.serverPushStallMs).toEqual({
      worktree: 45_000,
      central: 0,
    });

    socket.serverSend({ kind: "ping", pushStallMs: 65_000 });
    await flush();
    expect(seen.at(-1)!.serverPushStallMs.worktree).toBe(65_000);
  });

  test("a ping without pushStallMs (an older server) reads as 0", async () => {
    const { client, socket } = await setup();
    socket.serverSend({ kind: "ping", pushStallMs: 45_000 });
    await flush();
    socket.serverSend({ kind: "ping" });
    await flush();
    expect(client.getChannelStatuses().serverPushStallMs.worktree).toBe(0);
  });

  test("an unchanged value notifies nobody", async () => {
    const { client, socket } = await setup();
    const listener = vi.fn();
    client.subscribeChannelStatuses(listener);
    listener.mockClear();
    socket.serverSend({ kind: "ping", pushStallMs: 0 });
    await flush();
    socket.serverSend({ kind: "ping" });
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  test("every tab on the shared socket records the ping", async () => {
    const hub = createTransportHub();
    const tabA = hub.tab();
    const first = new NotificationsClient(new QueryClient(), {
      makeSocket: hub.makeSocket(tabA),
    });
    clients.push(first);
    await flush();
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();
    const tabB = hub.tab();
    const second = new NotificationsClient(new QueryClient(), {
      makeSocket: hub.makeSocket(tabB),
    });
    clients.push(second);
    await flush(); // B attached to the same worker socket
    expect(second.debugSnapshot().transport.worktree.attachedTabs).toBe(2);

    socket.serverSend({ kind: "ping", pushStallMs: 90_000 });
    await flush(); // the worker's fan-out reaches both tabs
    expect(first.getChannelStatuses().serverPushStallMs.worktree).toBe(90_000);
    expect(second.getChannelStatuses().serverPushStallMs.worktree).toBe(90_000);
  });

  test("a socket drop clears it", async () => {
    const { client, socket } = await setup();
    socket.serverSend({ kind: "ping", pushStallMs: 120_000 });
    await flush();
    expect(client.getChannelStatuses().serverPushStallMs.worktree).toBe(
      120_000,
    );
    socket.serverClose();
    await flush();
    expect(client.getChannelStatuses().worktree).not.toBe("open");
    expect(client.getChannelStatuses().serverPushStallMs.worktree).toBe(0);
  });
});
