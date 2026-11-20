/**
 * The cold-start HTTP prime belongs to the SUB, not to its readers: a tuple
 * subscribed before its socket was ever open reads its first value over HTTP
 * once (`observe`), however many readers join it while that read is in
 * flight; a reader joining after it failed sends it again. A prime per reader sent the in-browser demo ~130
 * identical config reads while its host booted (72× `config-v2.scopes` for
 * one tuple).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import { z } from "zod";
import { QueryClient } from "@tanstack/react-query";
import { createTransportHub } from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient, queryKeyFor } from "../notifications-client";

const schema = z.object({ status: z.string() });

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — cold-start prime", () => {
  const clients: NotificationsClient[] = [];
  let asked: string[] = [];

  async function setup(opts: {
    open: boolean;
    /** Answer every read with a network failure (a host not up yet). */
    failing?: boolean;
  }) {
    const hub = createTransportHub();
    const qc = new QueryClient();
    const client = new NotificationsClient(qc, {
      makeSocket: hub.makeSocket(hub.tab()),
      tabId: "tab-a",
      // A host still booting: the read stays in flight (or fails, `failing`).
      fetchImpl: (input) => {
        asked.push(new URL(String(input), "http://x").pathname);
        if (opts.failing === true)
          return Promise.reject(new TypeError("Failed to fetch"));
        return new Promise<Response>(() => {});
      },
    });
    clients.push(client);
    client.connect();
    await flush();
    if (opts.open) {
      hub.server.all()[0]!.open();
      await flush();
    }
    return { client, qc };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    asked = [];
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.useRealTimers();
  });

  test("many readers of one tuple before the socket's first open: one HTTP read", async () => {
    const { client } = await setup({ open: false });
    for (let i = 0; i < 50; i++) client.observe("k", {}, undefined, { schema });
    client.observe("k", { a: "1" }, undefined, { schema });
    await flush();
    expect(asked).toEqual(["/api/resources/k", "/api/resources/k"]);
  });

  test("a reader joining after the prime failed primes again — never two at once", async () => {
    const { client } = await setup({ open: false, failing: true });
    client.observe("k", {}, undefined, { schema });
    client.observe("k", {}, undefined, { schema }); // joins the one in flight
    await flush(); // the read fails (swallowed: the socket will deliver)
    expect(asked).toEqual(["/api/resources/k"]);
    client.observe("k", {}, undefined, { schema });
    await flush();
    expect(asked).toEqual(["/api/resources/k", "/api/resources/k"]);
  });

  test("a tuple already holding a value (boot-hydrated) is not primed", async () => {
    const { client, qc } = await setup({ open: false });
    qc.setQueryData(queryKeyFor("k", {}), { status: "hydrated" });
    client.observe("k", {}, undefined, { schema });
    await flush();
    expect(asked).toEqual([]);
  });

  test("once the socket has opened, a new sub is not primed", async () => {
    const { client } = await setup({ open: true });
    client.observe("k", {}, undefined, { schema });
    await flush();
    expect(asked).toEqual([]);
  });
});
