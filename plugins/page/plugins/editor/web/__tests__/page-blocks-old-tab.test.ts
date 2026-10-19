/**
 * C39 evidence for `pageBlocks` (plan A.4 of
 * research/2026-10-19-global-live-compiled-narrowing.md): what a tab still
 * running the bundle that declared `page-blocks` as a param'd VALUE
 * (`liveValue("page-blocks", { schema: z.array(BlockSchema), params:
 * ["pageId"] })` — a non-keyed read) would do with the frames the scoped
 * collection sends, had the key been kept.
 *
 * The REAL client, on a fake transport (`createTransportHub`): the sub-ack
 * parses and lands (the wire rows are `Block`s field for field — pinned
 * server-side by `server/internal/page-blocks-oracle.test.ts`), and then the
 * first keyed `delta` THROWS "no keyOf registered" — reported as a crash,
 * the cache left on the stale page, no resubscribe and no Reload prompt. A
 * loud failure, but a frozen page: so the key was renamed (`page-blocks.v2`),
 * and the old one is refused `unknown-key`, a `skew` verdict.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { createTransportHub } from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient } from "@plugins/primitives/plugins/live-state/web/testing";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { BlockSchema } from "../../core/schemas";

const OLD_KEY = "page-blocks";
const params = { pageId: "page-w" };
const row = (id: string, text: string) => ({
  id,
  pageId: "page-w",
  parentId: "page-w",
  type: "text",
  data: { text: [{ text }] },
  rank: "a0",
  expanded: true,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("C39 — an old tab's non-keyed `page-blocks` read, handed the scoped set's frames", () => {
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

  test("parses the sub-ack, then throws on the first keyed delta: the page freezes, with no resub", async () => {
    // The client re-throws a frame it cannot apply on a microtask, for the
    // crash reporter; catch it here instead of failing the run.
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
    await flush();
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();

    // The old descriptor: a VALUE — a schema, and no row identity.
    client.observe(OLD_KEY, params, undefined, {
      schema: z.array(BlockSchema),
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
      value: [row("a", "A"), row("b", "B")],
      version: 1,
    });
    await flush();
    const qk = queryKeyFor(OLD_KEY, params);
    const landed = qc.getQueryData<{ id: string }[]>(qk);
    expect(landed?.map((b) => b.id)).toEqual(["a", "b"]);

    // The scoped set's next frame: a keyed delta (another block's typing).
    socket.serverSend({
      kind: "delta",
      key: OLD_KEY,
      params,
      upserts: [["b", row("b", "typed")]],
      deletes: [],
      version: 2,
    });
    await flush();
    expect(thrown).toHaveLength(1);
    expect(String(thrown[0])).toMatch(/no keyOf registered/);
    // Frozen: the cache still holds the sub-ack's rows, and nothing re-asked.
    expect(qc.getQueryData(qk)).toBe(landed);
    expect(subs()).toBe(subsBefore);
  });
});
