/**
 * The `update` client latency sample (`reportUpdateLatency`): the REAL client on
 * a `createTransportHub()` fake server, frames pushed through the socket, the
 * samples read off `clientLatencySink`.
 *
 * Pins:
 *   - an applied update / delta carrying `timing` emits ONE sample whose four
 *     phases split change → applied (server-notice, server-deliver, transport,
 *     client-apply) and whose total is measured, not summed;
 *   - frames no change stands behind (sub-ack, timing-less update) emit nothing;
 *   - a delta that dead-ends in a forced resubscribe (no base, drifted base)
 *     wrote nothing, so it emits nothing (the false-sample regression);
 *   - the hidden rule: hidden now, or hidden at any instant since `changedAt`;
 *   - no sample is built while nobody subscribes.
 *
 * Conventions as in `notifications-subs.test.ts`: `clientLog` mocked, fake
 * timers (which also pin `Date.now()`), every client `destroy()`-ed.
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
import {
  clientLatencySink,
  type ClientLatencySample,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { NotificationsClient } from "../notifications-client";

const pushSchema = z.object({ status: z.string() });
const keyedSchema = z.array(
  z.object({ id: z.string(), n: z.number().optional() }),
);
const keyOf = (row: unknown): string => (row as { id: string }).id;

const NOW = 1_000_000;

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

let visibility: DocumentVisibilityState = "visible";
function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("NotificationsClient — update latency sample", () => {
  const clients: NotificationsClient[] = [];
  const unsubs: (() => void)[] = [];
  let samples: ClientLatencySample[];

  function listen(): void {
    unsubs.push(clientLatencySink.subscribe((s) => samples.push(s)));
  }

  async function setup(): Promise<{
    client: NotificationsClient;
    socket: FakeWebSocket;
    qc: QueryClient;
  }> {
    const hub = createTransportHub();
    const qc = new QueryClient();
    const client = new NotificationsClient(qc, {
      makeSocket: hub.makeSocket(hub.tab()),
    });
    clients.push(client);
    await flush();
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();
    return { client, socket, qc };
  }

  /** Observe a plain value read and land its (timing-less) sub-ack. */
  async function seedValue(
    client: NotificationsClient,
    socket: FakeWebSocket,
  ): Promise<void> {
    client.observe("k", { a: "1" }, undefined, { schema: pushSchema });
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: { a: "1" },
      value: { status: "v1" },
      version: 1,
    });
    await flush();
  }

  // The server stamped the change 300ms before now, noticed it 200ms later,
  // spent 40ms delivering and sent it 60ms before now.
  const timing = {
    changedAt: NOW - 300,
    sentAt: NOW - 60,
    deliverMs: 40,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    samples = [];
  });

  afterEach(() => {
    for (const u of unsubs.splice(0)) u();
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("an applied update with timing emits one sample with its four phases", async () => {
    const { client, socket } = await setup();
    await seedValue(client, socket);
    listen();
    expect(samples).toHaveLength(0); // the sub-ack carries no timing

    socket.serverSend({
      kind: "update",
      key: "k",
      params: { a: "1" },
      value: { status: "v2" },
      version: 2,
      timing,
    });
    await flush();

    expect(samples).toEqual([
      {
        signal: "update",
        key: "k",
        params: { a: "1" },
        phases: {
          "server-notice": 200,
          "server-deliver": 40,
          transport: 60,
          "client-apply": 0, // the fake clock does not move inside one frame
        },
        totalMs: 300,
        hidden: false,
      },
    ]);
  });

  test("an update without timing emits nothing", async () => {
    const { client, socket } = await setup();
    await seedValue(client, socket);
    listen();
    socket.serverSend({
      kind: "update",
      key: "k",
      params: { a: "1" },
      value: { status: "v2" },
      version: 2,
    });
    await flush();
    expect(samples).toHaveLength(0);
  });

  test("a cross-clock negative phase clamps to 0; the total stays measured", async () => {
    const { client, socket } = await setup();
    await seedValue(client, socket);
    listen();
    // The browser clock runs behind the server's: receipt "before" the send.
    socket.serverSend({
      kind: "update",
      key: "k",
      params: { a: "1" },
      value: { status: "v2" },
      version: 2,
      timing: { changedAt: NOW - 100, sentAt: NOW + 50, deliverMs: 10 },
    });
    await flush();
    expect(samples).toHaveLength(1);
    expect(samples[0]!.phases).toEqual({
      "server-notice": 140,
      "server-deliver": 10,
      transport: 0,
      "client-apply": 0,
    });
    expect(samples[0]!.totalMs).toBe(100);
  });

  test("an applied delta with timing emits one sample", async () => {
    const { client, socket } = await setup();
    client.observe("rk", {}, undefined, { schema: keyedSchema }, keyOf);
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "rk",
      params: {},
      value: [{ id: "a", n: 1 }],
      version: 1,
    });
    await flush();
    listen();

    socket.serverSend({
      kind: "delta",
      key: "rk",
      params: {},
      upserts: [["a", { id: "a", n: 2 }]],
      deletes: [],
      version: 2,
      timing,
    });
    await flush();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      signal: "update",
      key: "rk",
      totalMs: 300,
    });
  });

  test("a no-base delta forces a resubscribe and emits nothing", async () => {
    const { client, socket } = await setup();
    client.observe("rk", {}, undefined, { schema: keyedSchema }, keyOf);
    await flush();
    listen();
    socket.serverSend({
      kind: "delta",
      key: "rk",
      params: {},
      upserts: [["a", { id: "a", n: 1 }]],
      deletes: [],
      order: ["a"],
      version: 1,
      timing,
    });
    await flush();
    expect(samples).toHaveLength(0);
  });

  test("a drifted delta forces a resubscribe and emits nothing", async () => {
    const { client, socket } = await setup();
    client.observe("rk", {}, undefined, { schema: keyedSchema }, keyOf);
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "rk",
      params: {},
      value: [{ id: "a", n: 1 }],
      version: 1,
    });
    await flush();
    listen();
    socket.serverSend({
      kind: "delta",
      key: "rk",
      params: {},
      upserts: [["b", { id: "b", n: 2 }]],
      deletes: [],
      order: ["a", "b", "c"], // "c" resolvable from neither → drift
      version: 2,
      timing,
    });
    await flush();
    expect(samples).toHaveLength(0);
  });

  test("hidden: a tab hidden now flags its sample", async () => {
    const { client, socket } = await setup();
    await seedValue(client, socket);
    listen();
    setVisibility("hidden");
    socket.serverSend({
      kind: "update",
      key: "k",
      params: { a: "1" },
      value: { status: "v2" },
      version: 2,
      timing,
    });
    await flush();
    expect(samples.map((s) => s.hidden)).toEqual([true]);
  });

  test("hidden: a tab hidden at any instant since the change flags its sample; one hidden before it does not", async () => {
    const { client, socket } = await setup();
    await seedValue(client, socket);
    listen();
    // Hidden and back BEFORE the change: the change's whole span was visible.
    setVisibility("hidden");
    setVisibility("visible");
    vi.setSystemTime(NOW + 1000);
    socket.serverSend({
      kind: "update",
      key: "k",
      params: { a: "1" },
      value: { status: "v2" },
      version: 2,
      timing: { changedAt: NOW + 900, sentAt: NOW + 950, deliverMs: 5 },
    });
    await flush();
    // Hidden and back AFTER the next change was stamped: throttled mid-span.
    setVisibility("hidden");
    setVisibility("visible");
    socket.serverSend({
      kind: "update",
      key: "k",
      params: { a: "1" },
      value: { status: "v3" },
      version: 3,
      timing: { changedAt: NOW + 950, sentAt: NOW + 990, deliverMs: 5 },
    });
    await flush();
    expect(samples.map((s) => s.hidden)).toEqual([false, true]);
  });

  test("no sample is built while nobody subscribes", async () => {
    const { client, socket } = await setup();
    await seedValue(client, socket);
    const emit = vi.spyOn(clientLatencySink, "emit");
    socket.serverSend({
      kind: "update",
      key: "k",
      params: { a: "1" },
      value: { status: "v2" },
      version: 2,
      timing,
    });
    await flush();
    expect(emit).not.toHaveBeenCalled();
  });
});
