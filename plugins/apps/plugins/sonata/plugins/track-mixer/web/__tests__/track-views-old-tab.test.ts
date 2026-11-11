/**
 * C39 evidence for `trackViews` (research/2026-11-02-global-live-composite-key-collections.md,
 * Decision 4): what a tab still running the bundle that declared
 * `sonata-track-view` as a param'd VALUE (a non-keyed read of `{ songId }`)
 * would do with the frames the scoped collection sends, had the key been kept:
 * the sub-ack parses (the rows are the same fields), then the first keyed
 * `delta` THROWS "no keyOf registered" — the song's mixer frozen, no
 * resubscribe, no Reload prompt. So the key was renamed
 * (`sonata-track-view.v2`), and the old one is refused `unknown-key`, a `skew`
 * verdict.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { createTransportHub } from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient } from "@plugins/network/plugins/live/plugins/live-state/web/testing";
import { queryKeyFor } from "@plugins/network/plugins/live/plugins/live-state/web";
import { trackViews } from "../../shared/resources";

// The old bundle's row schema, as it shipped.
const OldTrackViewSchema = z.object({
  songId: z.string(),
  trackId: z.string(),
  color: z.string().nullable(),
  instrument: z.string().nullable(),
  muted: z.boolean(),
  hidden: z.boolean(),
  volume: z.number(),
});

const OLD_KEY = "sonata-track-view";
const SONG = "song-1793321937-a4niky";
const params = { songId: SONG };
const row = (trackId: string) => ({
  songId: SONG,
  trackId,
  color: null,
  instrument: null,
  muted: true,
  hidden: false,
  volume: 1,
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("C39 — an old tab's non-keyed `sonata-track-view` read, handed the scoped set's frames", () => {
  const clients: NotificationsClient[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("the new key is not the old one", () => {
    expect(trackViews.all.key).toBe("sonata-track-view.v2");
  });

  test("parses the sub-ack, then throws on the first keyed delta: frozen, with no resub", async () => {
    const thrown: unknown[] = [];
    const queue = globalThis.queueMicrotask.bind(globalThis);
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((cb) => {
      queue(() => {
        try {
          cb();
        } catch (err) {
          thrown.push(err);
        }
      });
    });
    const hub = createTransportHub();
    const qc = new QueryClient();
    const client = new NotificationsClient(qc, {
      makeSocket: hub.makeSocket(hub.tab()),
    });
    clients.push(client);
    client.connect();
    await flush();
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();

    // The old descriptor: a VALUE — a schema, and no row identity.
    client.observe(OLD_KEY, params, undefined, {
      schema: z.array(OldTrackViewSchema),
    });
    await flush();
    const subs = () =>
      socket.sentJson().filter((m) => m.op === "sub" && m.key === OLD_KEY)
        .length;
    const subsBefore = subs();
    socket.serverSend({
      kind: "sub-ack",
      key: OLD_KEY,
      params,
      value: [row("t0")],
      version: 1,
    });
    await flush();
    const qk = queryKeyFor(OLD_KEY, params);
    const landed = qc.getQueryData<{ trackId: string }[]>(qk);
    expect(landed?.map((v) => v.trackId)).toEqual(["t0"]);

    // The scoped set's next frame: a keyed delta (a second track muted).
    const added = row("t1");
    socket.serverSend({
      kind: "delta",
      key: OLD_KEY,
      params,
      upserts: [[trackViews.all.keyed.keyOf(added), added]],
      deletes: [],
      version: 2,
    });
    await flush();
    expect(thrown).toHaveLength(1);
    expect(String(thrown[0])).toMatch(/no keyOf registered/);
    expect(qc.getQueryData(qk)).toBe(landed);
    expect(subs()).toBe(subsBefore);
  });
});
