/**
 * NotificationsClient speaks one frame vocabulary, and says so: its shared
 * socket's dialect is the vocabulary's id (`PROTOCOL`,
 * `packages/resource-protocol`) — never anything per build, so tabs of two
 * builds that read frames alike share one socket — and every `sub` /
 * `sub-batch` it sends names it, so the server can refuse a derivation asked
 * under another vocabulary. Pinned on the REAL client over a
 * `createTransportHub()` fake server.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { PROTOCOL } from "@plugins/packages/plugins/resource-protocol/core";
import type { SharedWebSocketOptions } from "@plugins/primitives/plugins/networking/web";
import { createTransportHub } from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient } from "../notifications-client";

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — the frame protocol", () => {
  const clients: NotificationsClient[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("the socket's dialect is PROTOCOL, so two clients share one socket; every sub and replay batch names it", async () => {
    const hub = createTransportHub();
    const asked: SharedWebSocketOptions[] = [];
    const tabClient = () => {
      const make = hub.makeSocket(hub.tab());
      const client = new NotificationsClient(new QueryClient(), {
        makeSocket: (url, options) => {
          asked.push(options);
          return make(url, options);
        },
      });
      clients.push(client);
      return client;
    };
    const a = tabClient();
    const b = tabClient();
    await flush();
    expect(asked).toEqual([{ dialect: PROTOCOL }, { dialect: PROTOCOL }]);
    expect(hub.workers.count()).toBe(1);
    expect(hub.server.all()).toHaveLength(1);

    const socket = hub.server.all()[0]!;
    a.observe("k", { p: "1" }, undefined, { schema: z.number() });
    b.observe("k", { p: "2" }, undefined, { schema: z.number() });
    socket.open(); // each tab replays its set in one batch
    await flush();
    const sent = socket.sentJson();
    const subs = sent.filter((m) => m.op === "sub" || m.op === "sub-batch");
    expect(subs.length).toBeGreaterThan(0);
    for (const m of subs) expect(m.protocol).toBe(PROTOCOL);
  });
});
