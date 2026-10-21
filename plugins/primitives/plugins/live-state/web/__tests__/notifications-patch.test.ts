/**
 * Patched reads (`ResourceDescriptor.patches`): the REAL client on a
 * `createTransportHub()` fake server. Pins:
 *   - a `patch` onto the wire value held at its `base` lands the next value,
 *     parsed, and keeps every part it did not touch;
 *   - the base is the WIRE value (a coerced field parses from it again);
 *   - a patch whose base is not the version held, or onto a read with no wire
 *     base (an HTTP body, a read not declared `patches`), writes nothing and
 *     forces a full resubscribe.
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

const schema = z.object({
  at: z.coerce.date(),
  blocks: z.array(z.object({ text: z.string() })),
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — patch frames", () => {
  const clients: NotificationsClient[] = [];

  async function setup(patches: boolean) {
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
    client.observe("k", {}, undefined, {
      schema,
      ...(patches ? { patches: true as const } : {}),
    });
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: {
        at: "2026-01-01T00:00:00.000Z",
        blocks: [{ text: "a" }, { text: "x" }],
      },
      version: 3,
      epoch: "e",
    });
    await flush();
    return { qc, socket };
  }

  const subs = (socket: FakeWebSocket) =>
    socket.sentJson().filter((m) => m.op === "sub").length;
  const read = (qc: QueryClient) =>
    qc.getQueryData(queryKeyFor("k", {})) as z.infer<typeof schema>;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.useRealTimers();
  });

  test("a patch onto the held base lands the next value, sharing what it did not touch", async () => {
    const { qc, socket } = await setup(true);
    const before = read(qc);
    socket.serverSend({
      kind: "patch",
      key: "k",
      params: {},
      base: 3,
      version: 4,
      ops: [{ at: ["blocks", 1, "text"], append: "yz" }],
    });
    await flush();
    const after = read(qc);
    expect(after.blocks.map((b) => b.text)).toEqual(["a", "xyz"]);
    expect(after.at).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(after.blocks[0]).toBe(before.blocks[0]);
    socket.serverSend({
      kind: "patch",
      key: "k",
      params: {},
      base: 4,
      version: 5,
      ops: [{ at: ["blocks"], push: [{ text: "n" }] }],
    });
    await flush();
    expect(read(qc).blocks.map((b) => b.text)).toEqual(["a", "xyz", "n"]);
  });

  test("a patch against another version resubscribes and writes nothing", async () => {
    const { qc, socket } = await setup(true);
    const before = read(qc);
    const subsBefore = subs(socket);
    socket.serverSend({
      kind: "patch",
      key: "k",
      params: {},
      base: 2,
      version: 4,
      ops: [{ at: ["blocks", 0, "text"], append: "!" }],
    });
    await flush();
    expect(read(qc)).toBe(before);
    expect(subs(socket)).toBe(subsBefore + 1);
  });

  test("a read not declared patched keeps no base: a patch resubscribes", async () => {
    const { qc, socket } = await setup(false);
    const before = read(qc);
    const subsBefore = subs(socket);
    socket.serverSend({
      kind: "patch",
      key: "k",
      params: {},
      base: 3,
      version: 4,
      ops: [{ at: ["blocks", 0, "text"], append: "!" }],
    });
    await flush();
    expect(read(qc)).toBe(before);
    expect(subs(socket)).toBe(subsBefore + 1);
  });
});
