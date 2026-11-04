/**
 * A frame the socket does not accept is never lost. Bun discards a frame sent
 * while a connection's buffer is past its `backpressureLimit` (`send` answers
 * 0) — a restart's replay of every tab's sub set on one shared socket reaches
 * it — and a dropped `update` left the tab on its old value while the
 * server's version moved on, with nothing ever telling it (the client probe's
 * "missed-updates" after restarts). The runtime holds an unaccepted frame and
 * every later one, in order, and sends them when the socket drains; a peer
 * that stops reading altogether is closed (its tabs replay) rather than held
 * without bound.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createResourceRuntime, type RuntimeSocket } from "./runtime";
import { tick } from "./test-support";

/** A socket whose buffer the test fills and drains: while `full`, `send` accepts nothing. */
function bufferedSocket() {
  const received: Array<{ kind: string; version?: number; value?: unknown }> =
    [];
  const state = { full: false, closed: null as number | null };
  const ws: RuntimeSocket = {
    send(raw) {
      if (state.full) return 0;
      const msg = JSON.parse(raw) as { kind: string };
      if (msg.kind !== "ping") received.push(msg);
      return raw.length;
    },
    close(code) {
      state.closed = code ?? 1000;
    },
  };
  return { ws, received, state };
}

function setup() {
  const runtime = createResourceRuntime({});
  let n = 0;
  const r = runtime.defineExternalResource({
    key: "counter",
    mode: "push",
    schema: z.number(),
    loader: () => ++n,
  });
  const socket = bufferedSocket();
  const handler = runtime.notificationsWsHandler;
  handler.open(socket.ws);
  const subscribe = async () => {
    handler.message(
      socket.ws,
      JSON.stringify({ op: "sub", key: "counter", params: {} }),
    );
    await tick();
  };
  return { runtime, r, handler, socket, subscribe };
}

describe("a frame the socket did not accept", () => {
  test("is held, with every frame after it, and sent in order on drain", async () => {
    const { r, handler, socket, subscribe } = setup();
    await subscribe();
    expect(socket.received.map((f) => f.kind)).toEqual(["sub-ack"]);

    socket.state.full = true;
    r.notify();
    await tick();
    r.notify();
    await tick();
    // Nothing reached the tab while its buffer was full.
    expect(socket.received).toHaveLength(1);

    socket.state.full = false;
    r.notify(); // a frame sent behind the held ones never overtakes them
    await tick();
    expect(socket.received).toHaveLength(1);

    handler.drain(socket.ws);
    const updates = socket.received.slice(1);
    expect(updates.map((f) => f.kind)).toEqual(["update", "update", "update"]);
    const versions = updates.map((f) => f.version!);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(updates.at(-1)!.value).toBe(4);

    // Drained: the next frame goes straight out.
    r.notify();
    await tick();
    expect(socket.received.at(-1)!.value).toBe(5);
  });

  test("a drain that fills the buffer again keeps the rest for the next drain", async () => {
    const { r, handler, socket, subscribe } = setup();
    await subscribe();
    socket.state.full = true;
    r.notify();
    await tick();
    r.notify();
    await tick();

    // The socket takes one frame, then is full again.
    let room = 1;
    const send = socket.ws.send.bind(socket.ws);
    socket.state.full = false;
    socket.ws.send = (raw) => (room-- > 0 ? send(raw) : 0);
    handler.drain(socket.ws);
    expect(socket.received.slice(1).map((f) => f.value)).toEqual([2]);

    socket.ws.send = send;
    handler.drain(socket.ws);
    expect(socket.received.slice(1).map((f) => f.value)).toEqual([2, 3]);
  });

  test("a backlog no drain empties is closed once it is old", async () => {
    const { r, socket, subscribe } = setup();
    await subscribe();
    const realNow = Date.now;
    try {
      socket.state.full = true;
      r.notify();
      await tick();
      expect(socket.state.closed).toBeNull();
      const start = realNow();
      Date.now = () => start + 61_000;
      r.notify(); // the heartbeat's ping is such a frame too
      await tick();
      expect(socket.state.closed).toBe(1013);
    } finally {
      Date.now = realNow;
    }
  });

  test("a peer that stops reading is closed, not held without bound", async () => {
    const runtime = createResourceRuntime({ reportError: () => {} });
    const big = "x".repeat(1024 * 1024);
    let n = 0;
    const r = runtime.defineExternalResource({
      key: "big",
      mode: "push",
      schema: z.string(),
      loader: () => `${++n}${big}`,
    });
    const socket = bufferedSocket();
    const handler = runtime.notificationsWsHandler;
    handler.open(socket.ws);
    handler.message(
      socket.ws,
      JSON.stringify({ op: "sub", key: "big", params: {} }),
    );
    await tick();
    socket.state.full = true;
    for (let i = 0; i < 100 && socket.state.closed === null; i++) {
      r.notify();
      await tick();
    }
    expect(socket.state.closed).toBe(1013);
  });
});
