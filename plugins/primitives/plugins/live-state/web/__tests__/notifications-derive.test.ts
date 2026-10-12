/**
 * NotificationsClient seeded derivation: a fresh `observe` naming a
 * `ResourceDerivation` sends a `sub` with `derive` — cut from the sources'
 * cached rows at their versions, under an id minted for it — and a DERIVED
 * `sub-ack` (no value, echoing that id) adopts exactly those rows. Pinned on
 * the REAL client over a `createTransportHub()` fake server:
 *
 *   - the `derive` frame: a fresh id, and each source's params, version and
 *     slice bounds;
 *   - a derived ack adopts the slice (the same row objects) at its version,
 *     and a later delta applies on top of it;
 *   - the fallback: a value-carrying sub-ack applies as any sub-ack, and the
 *     derivation is gone;
 *   - nothing is seeded when a source moved since the caller decided (its
 *     `appliedSeq`), is not held, or names a row it does not hold;
 *   - nor from a source nothing was applied to since boot (`appliedSeq` 0:
 *     a hydrated value before its first sub-ack) — counted on the
 *     `live-pages` log channel;
 *   - a derived ack answering another derivation (another tab's, on the
 *     shared socket — even of the very same slices) adopts nothing — no
 *     value, no version;
 *   - a replay (socket reopen), a forced resub (a delta with no base) and a
 *     sub-error each drop the derivation in flight: the resub asks for a full
 *     value, and a late derived ack is dropped while the full answer applies;
 *   - `derive` is read on a fresh sub only, never on a refcount bump.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

const logged = vi.hoisted(() => [] as { channel: string; line: string }[]);
vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: (channel: string, line: string) => {
    logged.push({ channel, line });
  },
}));

import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  createTransportHub,
  type FakeWebSocket,
} from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient, queryKeyFor } from "../notifications-client";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (row: unknown): string => (row as { id: string }).id;
const KEY = "pages";
const SRC = { limit: "3" };
const NEW = { limit: "6", until: "k2" };

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — seeded derivation", () => {
  const clients: NotificationsClient[] = [];

  async function setup() {
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
    // The source tuple, settled over the socket at version 4.
    client.observe(KEY, SRC, undefined, { schema: rowsSchema }, keyOf);
    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: SRC,
      value: [
        { id: "a", n: 1 },
        { id: "b", n: 2 },
        { id: "c", n: 3 },
      ],
      version: 4,
    });
    await flush();
    return { qc, client, socket, hub };
  }

  const subsOf = (socket: FakeWebSocket, params: Record<string, string>) =>
    socket
      .sentJson()
      .filter(
        (m) =>
          m.op === "sub" &&
          m.key === KEY &&
          JSON.stringify(m.params) === JSON.stringify(params),
      );

  const derivation = (client: NotificationsClient, until = "b") => ({
    from: [
      {
        params: SRC,
        appliedSeq: client.appliedSeq(KEY, SRC),
        after: null,
        until,
      },
    ],
  });
  const sources = [{ params: SRC, version: 4, after: null, until: "b" }];
  /** The derived ack's echo of the derivation the (only) sub of `params` sent. */
  const echoOf = (socket: FakeWebSocket, params: Record<string, string>) => ({
    id: (subsOf(socket, params)[0]!.derive as { id: string }).id,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("the sub carries the derivation, and a derived ack adopts the slice — the same row objects — at its version", async () => {
    const { qc, client, socket } = await setup();
    client.observe(
      KEY,
      NEW,
      undefined,
      { schema: rowsSchema },
      keyOf,
      derivation(client),
    );
    await flush();
    const [sub] = subsOf(socket, NEW);
    expect(sub!.derive).toEqual({ id: expect.any(String), from: sources });

    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      version: 1,
      derived: echoOf(socket, NEW),
    });
    await flush();
    const source = qc.getQueryData(queryKeyFor(KEY, SRC)) as unknown[];
    const derived = qc.getQueryData(queryKeyFor(KEY, NEW)) as unknown[];
    expect(derived).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(derived[0]).toBe(source[0]);
    expect(client.appliedSeq(KEY, NEW)).toBeGreaterThan(
      client.appliedSeq(KEY, SRC),
    );

    // The tuple is live from that base: a delta applies on top.
    socket.serverSend({
      kind: "delta",
      key: KEY,
      params: NEW,
      upserts: [["x", { id: "x", n: 0 }]],
      deletes: [],
      order: ["x", "a", "b"],
      version: 2,
    });
    await flush();
    expect(qc.getQueryData(queryKeyFor(KEY, NEW))).toEqual([
      { id: "x", n: 0 },
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
  });

  test("the fallback: a value-carrying sub-ack applies, and a late derived echo adopts nothing", async () => {
    const { qc, client, socket } = await setup();
    client.observe(
      KEY,
      NEW,
      undefined,
      { schema: rowsSchema },
      keyOf,
      derivation(client),
    );
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      value: [{ id: "a", n: 1 }],
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(queryKeyFor(KEY, NEW))).toEqual([{ id: "a", n: 1 }]);
    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      version: 2,
      derived: echoOf(socket, NEW),
    });
    await flush();
    expect(qc.getQueryData(queryKeyFor(KEY, NEW))).toEqual([{ id: "a", n: 1 }]);
  });

  test("nothing is seeded from a source applied since, not held, or not holding the bound", async () => {
    const { client, socket } = await setup();
    const stale = derivation(client);
    socket.serverSend({
      kind: "update",
      key: KEY,
      params: SRC,
      value: [{ id: "a", n: 1 }],
      version: 5,
    });
    await flush();
    client.observe(KEY, NEW, undefined, { schema: rowsSchema }, keyOf, stale);
    client.observe(
      KEY,
      { limit: "5" },
      undefined,
      { schema: rowsSchema },
      keyOf,
      {
        from: [
          { params: { limit: "9" }, appliedSeq: 1, after: null, until: null },
        ],
      },
    );
    client.observe(
      KEY,
      { limit: "7" },
      undefined,
      { schema: rowsSchema },
      keyOf,
      derivation(client, "zz"),
    );
    await flush();
    expect(subsOf(socket, NEW)[0]!.derive).toBeUndefined();
    expect(subsOf(socket, { limit: "5" })[0]!.derive).toBeUndefined();
    expect(subsOf(socket, { limit: "7" })[0]!.derive).toBeUndefined();
  });

  test("nothing is seeded from a source holding a boot-hydrated value — and the refusal is logged on live-pages", async () => {
    const { qc, client, socket } = await setup();
    // A hydrated source: a cached value, its sub sent, no sub-ack yet.
    const BOOT = { limit: "2" };
    qc.setQueryData(queryKeyFor(KEY, BOOT), [{ id: "a", n: 1 }]);
    client.observe(KEY, BOOT, undefined, rowsSchema, keyOf);
    expect(client.appliedSeq(KEY, BOOT)).toBe(0);
    logged.length = 0;
    client.observe(KEY, NEW, undefined, rowsSchema, keyOf, {
      from: [{ params: BOOT, appliedSeq: 0, after: null, until: "a" }],
    });
    await flush();
    expect(subsOf(socket, NEW)[0]!.derive).toBeUndefined();
    expect(
      logged.filter(
        (l) => l.channel === "live-pages" && l.line.includes("seed refused"),
      ),
    ).toHaveLength(1);
  });

  test("a source still loading seeds nothing, and is no boot refusal: nothing is logged", async () => {
    const { client, socket } = await setup();
    // A fresh sub, its first answer not landed and nothing cached.
    const FRESH = { limit: "2" };
    client.observe(KEY, FRESH, undefined, rowsSchema, keyOf);
    expect(client.appliedSeq(KEY, FRESH)).toBe(0);
    logged.length = 0;
    client.observe(KEY, NEW, undefined, rowsSchema, keyOf, {
      from: [{ params: FRESH, appliedSeq: 0, after: null, until: "a" }],
    });
    await flush();
    expect(subsOf(socket, NEW)[0]!.derive).toBeUndefined();
    expect(
      logged.filter(
        (l) => l.channel === "live-pages" && l.line.includes("seed refused"),
      ),
    ).toHaveLength(0);
  });

  test("a derived ack answering another derivation adopts nothing; the tab's own answer still applies", async () => {
    const { qc, client, socket } = await setup();
    // This tab subscribes plainly; another tab derived the tuple.
    client.observe(KEY, NEW, undefined, { schema: rowsSchema }, keyOf);
    await flush();
    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      version: 1,
      derived: { id: "another-tab" },
    });
    await flush();
    expect(qc.getQueryState(queryKeyFor(KEY, NEW))?.dataUpdatedAt ?? 0).toBe(0);
    // Its own answer, at the same version, is not dropped as stale.
    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      value: [{ id: "a", n: 1 }],
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(queryKeyFor(KEY, NEW))).toEqual([{ id: "a", n: 1 }]);

    // One that asked a derivation of its own — the very same slices another
    // tab may ask — adopts nothing from an answer to another's.
    client.observe(
      KEY,
      { limit: "8" },
      undefined,
      { schema: rowsSchema },
      keyOf,
      derivation(client),
    );
    await flush();
    expect(echoOf(socket, { limit: "8" }).id).not.toBe("another-tab");
    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: { limit: "8" },
      version: 1,
      derived: { id: "another-tab" },
    });
    await flush();
    expect(
      qc.getQueryState(queryKeyFor(KEY, { limit: "8" }))?.dataUpdatedAt ?? 0,
    ).toBe(0);
  });

  test("a socket reopen replays the sub plain, and a late derived ack is dropped while the replay's answer applies", async () => {
    const { qc, client, socket, hub } = await setup();
    client.observe(
      KEY,
      NEW,
      undefined,
      { schema: rowsSchema },
      keyOf,
      derivation(client),
    );
    await flush();
    const echo = echoOf(socket, NEW);

    socket.serverClose();
    // The reconnect backoff's first step is at most 1 s, whatever its jitter.
    await vi.advanceTimersByTimeAsync(1000);
    const socket2 = hub.server.all().find((w) => w.readyState === 0)!;
    expect(socket2).toBeDefined();
    socket2.open();
    await flush();
    const batch = socket2.sentJson().find((m) => m.op === "sub-batch")!;
    const entry = (batch.entries as Record<string, unknown>[]).find(
      (e) => JSON.stringify(e.params) === JSON.stringify(NEW),
    )!;
    expect(entry).toBeDefined();
    expect("derive" in entry).toBe(false);

    socket2.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      version: 1,
      derived: echo,
    });
    await flush();
    expect(qc.getQueryState(queryKeyFor(KEY, NEW))?.dataUpdatedAt ?? 0).toBe(0);
    socket2.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      value: [{ id: "a", n: 1 }],
      version: 1,
    });
    await flush();
    expect(qc.getQueryData(queryKeyFor(KEY, NEW))).toEqual([{ id: "a", n: 1 }]);
  });

  test("a forced resub (a delta with no base) asks plain, and a late derived ack is dropped while the resub's answer applies", async () => {
    const { qc, client, socket } = await setup();
    client.observe(
      KEY,
      NEW,
      undefined,
      { schema: rowsSchema },
      keyOf,
      derivation(client),
    );
    await flush();
    const echo = echoOf(socket, NEW);
    socket.serverSend({
      kind: "delta",
      key: KEY,
      params: NEW,
      upserts: [["x", { id: "x", n: 0 }]],
      deletes: [],
      version: 1,
    });
    await flush();
    const subs = subsOf(socket, NEW);
    expect(subs).toHaveLength(2);
    expect(subs[1]!.derive).toBeUndefined();

    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      version: 2,
      derived: echo,
    });
    await flush();
    expect(qc.getQueryState(queryKeyFor(KEY, NEW))?.dataUpdatedAt ?? 0).toBe(0);
    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      value: [{ id: "a", n: 1 }],
      version: 2,
    });
    await flush();
    expect(qc.getQueryData(queryKeyFor(KEY, NEW))).toEqual([{ id: "a", n: 1 }]);
  });

  test("a sub-error drops the derivation: the HTTP fallback runs, and a late derived ack is dropped", async () => {
    const { qc, client, socket } = await setup();
    const fetchQuery = vi.spyOn(qc, "prefetchQuery").mockResolvedValue();
    client.observe(
      KEY,
      NEW,
      undefined,
      { schema: rowsSchema },
      keyOf,
      derivation(client),
    );
    await flush();
    const echo = echoOf(socket, NEW);
    socket.serverSend({
      kind: "sub-error",
      key: KEY,
      params: NEW,
      reason: "loader-failed",
    });
    await flush();
    expect(fetchQuery).toHaveBeenCalledTimes(1);
    expect(fetchQuery.mock.calls[0]![0]).toMatchObject({
      queryKey: queryKeyFor(KEY, NEW),
    });

    socket.serverSend({
      kind: "sub-ack",
      key: KEY,
      params: NEW,
      version: 1,
      derived: echo,
    });
    await flush();
    expect(qc.getQueryState(queryKeyFor(KEY, NEW))?.dataUpdatedAt ?? 0).toBe(0);
  });

  test("derive is read on a fresh sub only — a refcount bump sends nothing", async () => {
    const { client, socket } = await setup();
    client.observe(KEY, NEW, undefined, { schema: rowsSchema }, keyOf);
    client.observe(
      KEY,
      NEW,
      undefined,
      { schema: rowsSchema },
      keyOf,
      derivation(client),
    );
    await flush();
    expect(subsOf(socket, NEW)).toHaveLength(1);
    expect(subsOf(socket, NEW)[0]!.derive).toBeUndefined();
  });
});
