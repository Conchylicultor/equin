/**
 * Held follows (`HeldFollows`): a TRACKED follower tuple's followed rows are
 * held by the runtime between loads, and dropped exactly when a change reaches
 * the tuple through that follow's routes (`Route.via`). Pinned here:
 *
 * - a recompute the follow did not cause (the value's own notify) reads the
 *   held rows — no nested read; a change through the follow drops them, and
 *   a gated change (untouched for the tuple) keeps them;
 * - two follows: a change reaching one drops that one only;
 * - a read in flight when a change reaches the follow is never held;
 * - a failed read is held by no one; an untracked read and a span that ended
 *   (N→0) hold nothing;
 * - revalidate and `onFollowReached` read through the same held rows;
 * - a value built on held rows ships no watermark (`getResourceValue`).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintReachPlan, type TableChange, type TupleUse } from "./routing";
import { createHarness, tick, type Harness } from "./test-support";
import type { HeldFollows, LoadRun, ResourceParams } from "./runtime";

const settle = async () => {
  await tick();
  await tick();
};

const reason = "the follow re-reads its follower whole";

/** Two follows: `ws` (conversations, matched on `id`) and `tail` (tails, matched on `id`). */
function reach() {
  return mintReachPlan<ResourceParams>({
    routes: [
      {
        id: "ws:base",
        table: "conversations",
        map: { kind: "full", reason },
        columns: ["attempt_id", "id"],
        match: ["id"],
        via: { name: "ws", collection: "conv-ws:rows" },
      },
      {
        id: "tail:base",
        table: "tails",
        map: { kind: "full", reason },
        columns: ["id", "session"],
        match: ["id"],
        via: { name: "tail", collection: "tails:rows" },
      },
    ],
    usesOf: (p) =>
      new Map<string, TupleUse>([
        ["ws:base", { role: "membership", match: { id: new Set([p.conv!]) } }],
        [
          "tail:base",
          { role: "membership", match: { id: new Set([p.conv!]) } },
        ],
      ]),
  });
}

const change = (
  table: string,
  ids: string[],
  unchanged: string[] | null = [],
): TableChange => ({
  source: "feed",
  table,
  op: "U",
  ids,
  keys: { id: ids },
  unchanged,
});

/** A pushed follower whose loader reads both follows through the run's held rows. */
function follower(
  h: Harness,
  o: {
    revalidate?: boolean;
    hook?: boolean;
    park?: () => Promise<void>;
    failNext?: { on: boolean };
  } = {},
) {
  const reads: string[] = [];
  let gen = 0;
  const readOf =
    (name: string, conv: string) => async (): Promise<readonly unknown[]> => {
      reads.push(`${name}:${conv}`);
      if (o.park) await o.park();
      if (o.failNext?.on) {
        o.failNext.on = false;
        throw new Error("read failed");
      }
      return [{ name, conv, gen }];
    };
  const readBoth = async (p: ResourceParams, held?: HeldFollows) => {
    const one = (name: string) =>
      held === undefined
        ? readOf(name, p.conv!)()
        : held.read(
            name,
            JSON.stringify({ ids: [p.conv] }),
            readOf(name, p.conv!),
          );
    return [await one("ws"), await one("tail")];
  };
  const handle = h.runtime.defineExternalResource(
    {
      key: "follower",
      schema: z.object({ rows: z.array(z.unknown()) }),
      validateParams: () => {},
    },
    {
      mode: "push",
      loader: async (p: ResourceParams, _ctx?: unknown, run?: LoadRun) => ({
        rows: await readBoth(p, run?.follows),
      }),
      reach: reach(),
      ...(o.revalidate
        ? {
            revalidate: async (p: ResourceParams, held?: HeldFollows) =>
              JSON.stringify(await readBoth(p, held)),
          }
        : {}),
      ...(o.hook
        ? {
            onFollowReached: async (p: ResourceParams, held?: HeldFollows) => {
              await readBoth(p, held);
              return "unchanged" as const;
            },
          }
        : {}),
    },
  );
  return {
    reads,
    handle,
    bump: () => {
      gen++;
    },
  };
}

async function debugOf(h: Harness) {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as {
    resources: {
      key: string;
      followHeldHits: number;
      followHeldDrops: number;
    }[];
  };
  return body.resources.find((r) => r.key === "follower")!;
}

describe("held follows", () => {
  test("the value's own notify reads the held rows; a change through a follow drops that follow only", async () => {
    const h = createHarness();
    const f = follower(h);
    await h.subscribe("follower", { conv: "a" });
    expect(f.reads).toEqual(["ws:a", "tail:a"]);
    f.reads.length = 0;

    // Not caused by a follow: no nested read.
    f.handle.notify({ conv: "a" });
    await settle();
    expect(f.reads).toEqual([]);

    // A gated change (only unread columns moved) reaches nothing.
    h.runtime.routeTableChange(change("tails", ["a"], ["id", "session"]));
    await settle();
    expect(f.reads).toEqual([]);

    // Another tuple's row reaches nothing either.
    h.runtime.routeTableChange(change("tails", ["b"]));
    await settle();
    expect(f.reads).toEqual([]);

    // The tuple's own tail moved: `tail` re-reads, `ws` stays held.
    f.bump();
    h.runtime.routeTableChange(change("tails", ["a"]));
    await settle();
    expect(f.reads).toEqual(["tail:a"]);
    expect(h.pushesFor("follower").at(-1)?.value).toEqual({
      rows: [
        [{ name: "ws", conv: "a", gen: 0 }],
        [{ name: "tail", conv: "a", gen: 1 }],
      ],
    });

    const dbg = await debugOf(h);
    expect(dbg.followHeldHits).toBe(3);
    expect(dbg.followHeldDrops).toBe(1);
  });

  test("a reconnect sweep (ids: null) drops every follow of the table", async () => {
    const h = createHarness();
    const f = follower(h);
    await h.subscribe("follower", { conv: "a" });
    f.reads.length = 0;
    h.runtime.routeTableChange({
      source: "feed",
      table: "conversations",
      op: "U",
      ids: null,
      keys: null,
      unchanged: null,
    });
    await settle();
    expect(f.reads).toEqual(["ws:a"]);
  });

  test("a read in flight when a change reaches its follow is never held", async () => {
    const h = createHarness();
    let release: () => void = () => {};
    let parked = false;
    const f = follower(h, {
      park: () =>
        parked
          ? new Promise<void>((res) => {
              release = res;
            })
          : Promise.resolve(),
    });
    await h.subscribe("follower", { conv: "a" });
    f.reads.length = 0;
    // A change drops `ws`; its re-read parks …
    parked = true;
    h.runtime.routeTableChange(change("conversations", ["a"]));
    await settle();
    expect(f.reads).toEqual(["ws:a"]);
    // … and another change reaches `ws` while it is in flight.
    h.runtime.routeTableChange(change("conversations", ["a"]));
    parked = false;
    release();
    await settle();
    await settle();
    // The parked read was never held: the drain the second change scheduled
    // read `ws` afresh instead of reusing it.
    expect(f.reads).toEqual(["ws:a", "ws:a"]);
    // Once settled, an own notify reads nothing.
    f.reads.length = 0;
    f.handle.notify({ conv: "a" });
    await settle();
    expect(f.reads).toEqual([]);
  });

  test("a failed read is held by no one", async () => {
    const h = createHarness({ reportError: () => {} });
    const failNext = { on: false };
    const f = follower(h, { failNext });
    await h.subscribe("follower", { conv: "a" });
    failNext.on = true;
    h.runtime.routeTableChange(change("conversations", ["a"]));
    await settle();
    f.reads.length = 0;
    f.handle.notify({ conv: "a" });
    await settle();
    expect(f.reads).toEqual(["ws:a"]);
  });

  test("an untracked read and an ended span hold nothing", async () => {
    const h = createHarness();
    const f = follower(h);
    await h.runtime.loadResourceByKey("follower", { conv: "a" });
    await h.runtime.loadResourceByKey("follower", { conv: "a" });
    expect(f.reads).toEqual(["ws:a", "tail:a", "ws:a", "tail:a"]);
    f.reads.length = 0;
    await h.subscribe("follower", { conv: "a" });
    await h.unsub("follower", { conv: "a" });
    f.reads.length = 0;
    await h.subscribe("follower", { conv: "a" });
    expect(f.reads).toEqual(["ws:a", "tail:a"]);
  });

  test("revalidate and onFollowReached read through the held rows", async () => {
    const h = createHarness();
    const f = follower(h, { revalidate: true, hook: true });
    await h.subscribe("follower", { conv: "a" });
    f.reads.length = 0;
    // The hook re-reads `ws` (dropped by the change); the load the change
    // scheduled and its frame's etag read what the hook read.
    h.runtime.routeTableChange(change("conversations", ["a"]));
    await settle();
    await settle();
    expect(f.reads).toEqual(["ws:a"]);
  });

  test("a value built on held rows ships no watermark; a fresh one does", async () => {
    let wm = 10;
    const h = createHarness({
      captureWatermark: () => Promise.resolve(String(wm++)),
    });
    const f = follower(h);
    await h.subscribe("follower", { conv: "a" });
    f.bump();
    // Every follow fresh (a sweep of both tables): a watermark.
    for (const table of ["conversations", "tails"]) {
      h.runtime.routeTableChange({
        source: "feed",
        table,
        op: "U",
        ids: null,
        keys: null,
        unchanged: null,
      });
    }
    await settle();
    const fresh = h.pushesFor("follower").at(-1)!;
    expect(fresh.watermark).toBeDefined();
    // One follow held: none.
    f.bump();
    h.runtime.routeTableChange(change("tails", ["a"]));
    await settle();
    const held = h.pushesFor("follower").at(-1)!;
    expect(held.version).toBeGreaterThan(fresh.version!);
    expect(held.watermark).toBeUndefined();
  });
});
