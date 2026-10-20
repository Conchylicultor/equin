/**
 * NotificationsClient — the unanswered-sub deadline. The server registers a sub
 * synchronously on receipt and always answers it (`sub-ack` / `up-to-date` /
 * `sub-error`), so a sub sent on an OPEN socket and still unanswered after
 * `UNANSWERED_SUB_MS` means the frame or its answer was lost between this tab
 * and the server while the transport reads "open" (2026-10-17: a SharedWorker
 * that had dropped the tab's port). The client reports it on
 * `unansweredSubReportSink` — never retries on its own.
 *
 * An answer is a frame echoing the request's `(tabId, id)` — not any frame for
 * the same tuple: the shared socket fans every frame out to every tab, and a
 * tab's version guard may drop its own answer (an `update` or HTTP read landed
 * first) without that answer having been lost (2026-10-19: ~97% of reports
 * were such dropped answers).
 *
 * Pins:
 *   - an unanswered sub is reported once, at the deadline, with its key;
 *   - an answered sub is never reported;
 *   - a sub-error counts as an answer;
 *   - an answer the version guard drops still counts as an answer;
 *   - another tab's answer for the same tuple does not answer this tab's sub;
 *   - a sub sent before the socket opens waits for the open's replay, which
 *     starts its clock — a socket that never opens is not this deadline's.
 *
 * Conventions follow the sibling suites: `clientLog` mocked to a no-op, fake
 * timers per test, every client `destroy()`-ed in afterEach.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { z } from "zod";
import { QueryClient } from "@tanstack/react-query";
import {
  createTransportHub,
  type FakeWebSocket,
} from "@plugins/primitives/plugins/networking/web/testing";
import {
  NotificationsClient,
  UNANSWERED_SUB_MS,
} from "../notifications-client";
import {
  unansweredSubReportSink,
  type UnansweredSubReport,
} from "../unanswered-sub-reporter";

const pushSchema = z.object({ status: z.string() });

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** The request identity of the last `sub` `tabId` sent for `key` — what an answer echoes. */
function requestOf(
  socket: FakeWebSocket,
  key: string,
  tabId: string,
): { id: number; tabId: string } {
  const sub = socket
    .sentJson()
    .filter((f) => f.op === "sub" && f.key === key && f.tabId === tabId)
    .at(-1);
  if (sub === undefined) throw new Error(`no sub for ${key} from ${tabId}`);
  return { id: sub.id as number, tabId };
}

describe("NotificationsClient — unanswered subs", () => {
  const clients: NotificationsClient[] = [];
  let reports: UnansweredSubReport[] = [];

  async function setup(opts: { open: boolean }): Promise<{
    hub: ReturnType<typeof createTransportHub>;
    client: NotificationsClient;
    socket: FakeWebSocket;
  }> {
    const hub = createTransportHub();
    const client = new NotificationsClient(new QueryClient(), {
      makeSocket: hub.makeSocket(hub.tab()),
      tabId: "tab-a",
    });
    clients.push(client);
    await flush();
    const socket = hub.server.all()[0]!;
    if (opts.open) {
      socket.open();
      await flush();
    }
    return { hub, client, socket };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    reports = [];
    unansweredSubReportSink.register((r) => reports.push(r));
  });

  afterEach(() => {
    unansweredSubReportSink.register(null);
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("a sub left unanswered on an open socket is reported once, at the deadline", async () => {
    const { client } = await setup({ open: true });
    client.observe("k", { a: "1" }, undefined, { schema: pushSchema });
    await flush();

    await vi.advanceTimersByTimeAsync(UNANSWERED_SUB_MS - 1);
    expect(reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports).toEqual([
      expect.objectContaining({
        socket: "worktree",
        count: 1,
        oldestKey: "k",
        oldestWaitMs: UNANSWERED_SUB_MS,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(UNANSWERED_SUB_MS * 3);
    expect(reports).toHaveLength(1);
  });

  test("an answered sub is never reported", async () => {
    const { client, socket } = await setup({ open: true });
    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      ...requestOf(socket, "k", "tab-a"),
      key: "k",
      params: {},
      value: { status: "ok" },
      version: 1,
    });
    await vi.advanceTimersByTimeAsync(UNANSWERED_SUB_MS * 2);
    expect(reports).toHaveLength(0);
  });

  test("a sub-error is an answer", async () => {
    const { client, socket } = await setup({ open: true });
    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    socket.serverSend({
      kind: "sub-error",
      ...requestOf(socket, "k", "tab-a"),
      key: "k",
      params: {},
      reason: "loader-failed",
    });
    await vi.advanceTimersByTimeAsync(UNANSWERED_SUB_MS * 2);
    expect(reports).toHaveLength(0);
  });

  test("an answer the version guard drops is still an answer", async () => {
    const { client, socket } = await setup({ open: true });
    client.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    // A change lands while the sub's load runs: the push reaches the tab
    // first, and the sub-ack — at the version it read before loading — is
    // dropped as stale.
    socket.serverSend({
      kind: "update",
      key: "k",
      params: {},
      value: { status: "newer" },
      version: 2,
    });
    socket.serverSend({
      kind: "sub-ack",
      ...requestOf(socket, "k", "tab-a"),
      key: "k",
      params: {},
      value: { status: "older" },
      version: 2,
    });
    await vi.advanceTimersByTimeAsync(UNANSWERED_SUB_MS * 2);
    expect(reports).toHaveLength(0);
  });

  test("another tab's answer for the same tuple does not answer this tab's sub", async () => {
    const { hub, client: tabA, socket } = await setup({ open: true });
    const tabB = new NotificationsClient(new QueryClient(), {
      makeSocket: hub.makeSocket(hub.tab()),
      tabId: "tab-b",
    });
    clients.push(tabB);
    await flush();
    expect(hub.server.all()).toHaveLength(1); // one shared socket

    tabA.observe("k", {}, undefined, { schema: pushSchema });
    tabB.observe("k", {}, undefined, { schema: pushSchema });
    await flush();
    // Only tab B's request is answered (tab A's was lost); the shared socket
    // fans the answer out to tab A too.
    socket.serverSend({
      kind: "sub-ack",
      ...requestOf(socket, "k", "tab-b"),
      key: "k",
      params: {},
      value: { status: "ok" },
      version: 1,
    });
    await vi.advanceTimersByTimeAsync(UNANSWERED_SUB_MS);
    expect(reports).toEqual([
      expect.objectContaining({ count: 1, oldestKey: "k" }),
    ]);
  });

  test("a sub sent before the socket opens is timed from the open's replay", async () => {
    const { hub, client } = await setup({ open: false });
    client.observe("k", {}, undefined, { schema: pushSchema });
    await vi.advanceTimersByTimeAsync(UNANSWERED_SUB_MS * 2);
    expect(reports).toHaveLength(0); // never open: not this deadline's

    // The transport redials a hung handshake meanwhile; open the live attempt.
    hub.server.all().at(-1)!.open();
    await flush();
    await vi.advanceTimersByTimeAsync(UNANSWERED_SUB_MS);
    expect(reports).toEqual([
      expect.objectContaining({ count: 1, oldestKey: "k" }),
    ]);
  });
});
