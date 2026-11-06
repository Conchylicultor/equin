/**
 * `answerJoinedMs`: how much of a sub-ack's server answer joined another run
 * in flight (the frame's `joinedMs`), handed to the mount → first data report
 * only while that sub-ack is still the value the sub holds and only to a read
 * mounted before it landed — never a stale join to a later settle.
 *
 * Conventions as in `notifications-subs.test.ts`: `clientLog` mocked, fake
 * timers, every client `destroy()`-ed.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  createTransportHub,
  type FakeWebSocket,
} from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient } from "../notifications-client";

const schema = z.object({ status: z.string() });
const params = { a: "1" };

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — answerJoinedMs", () => {
  const clients: NotificationsClient[] = [];

  async function setup(): Promise<{
    client: NotificationsClient;
    socket: FakeWebSocket;
  }> {
    const hub = createTransportHub();
    const client = new NotificationsClient(new QueryClient(), {
      makeSocket: hub.makeSocket(hub.tab()),
    });
    clients.push(client);
    await flush();
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();
    client.observe("k", params, undefined, { schema });
    await flush();
    return { client, socket };
  }

  const subAck = (version: number, joinedMs?: number) => ({
    kind: "sub-ack",
    key: "k",
    params,
    value: { status: `v${version}` },
    version,
    ...(joinedMs !== undefined ? { joinedMs } : {}),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("a read mounted before the sub-ack gets its join; one mounted after does not", async () => {
    const mountedAt = performance.now();
    const { client, socket } = await setup();
    socket.serverSend(subAck(1, 2400));
    await flush();
    expect(client.answerJoinedMs("k", params, undefined, mountedAt)).toBe(2400);
    await vi.advanceTimersByTimeAsync(10);
    expect(
      client.answerJoinedMs("k", params, undefined, performance.now()),
    ).toBe(0);
  });

  test("a later value supersedes the sub-ack's join", async () => {
    const mountedAt = performance.now();
    const { client, socket } = await setup();
    socket.serverSend(subAck(1, 2400));
    await flush();
    socket.serverSend({
      kind: "update",
      key: "k",
      params,
      value: { status: "v2" },
      version: 2,
    });
    await flush();
    expect(client.answerJoinedMs("k", params, undefined, mountedAt)).toBe(0);
  });

  test("a sub-ack with no join, or no sub at all, answers 0", async () => {
    const mountedAt = performance.now();
    const { client, socket } = await setup();
    socket.serverSend(subAck(1));
    await flush();
    expect(client.answerJoinedMs("k", params, undefined, mountedAt)).toBe(0);
    expect(client.answerJoinedMs("other", {}, undefined, mountedAt)).toBe(0);
  });
});
