/**
 * The keyed snapshot a routed window reads membership off — who may write it,
 * and when (research/2026-09-29-global-scoped-change-routing.md, final review).
 *
 * The router drops a value-role change to a host its snapshot does not hold (a
 * non-member's side write changes nothing on screen). That is sound only while
 * the snapshot is at least as new as every change routed to the tuple, so two
 * writers must never set an older one:
 *  - a sub-ack whose read STARTED before a push advanced the snapshot — also
 *    when the subscriber joined that read after the push (it observed the new
 *    version, but the value is the older read's);
 *  - a drain that outlived the tuple's last unsubscribe — nothing routes to an
 *    untracked tuple, so the snapshot it wrote back would go stale unseen.
 *
 * Each scenario ends with a side write to a host the stale base would lack,
 * and asserts every client converges on the truth.
 */

import { expect, test } from "bun:test";
import { z } from "zod";
import { mintRoutePlan } from "./routing";
import { createHarness, makeClientView, tick } from "./test-support";
import type { ResourceParams } from "./runtime";

const rowSchema = z.object({
  id: z.string(),
  n: z.number(),
  tag: z.string().nullable(),
});
type Row = z.infer<typeof rowSchema>;
const keyOf = (r: unknown) => (r as Row).id;
const L2 = { limit: "2" };

const settle = async () => {
  await tick();
  await tick();
};

// `hosts` ordered by `n`, and a 1:1 extension carrying `tag` (value role: no
// tuple filters or sorts by it).
function fixture(sockets: number) {
  const hosts = new Map<string, number>([
    ["h1", 1],
    ["h2", 2],
    ["h3", 3],
  ]);
  const ext = new Map<string, string>();
  const loads: Array<readonly string[] | "FULL"> = [];
  let parkNext: Promise<void> | null = null;
  const members = (limit: number): Row[] =>
    [...hosts]
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([id, n]) => ({ id, n, tag: ext.get(id) ?? null }));
  const reports: string[] = [];
  const h = createHarness({ sockets, reportError: (c) => reports.push(c) });
  h.runtime.defineResource(
    {
      key: "win",
      schema: z.array(rowSchema),
      keyed: { keyOf },
      validateParams: () => {},
    },
    {
      routes: mintRoutePlan({
        routes: [
          {
            id: "hosts",
            table: "hosts",
            map: { kind: "identity" },
            columns: ["id", "n"],
          },
          {
            id: "ext",
            table: "hosts_ext",
            map: { kind: "alias", column: "parent_id" },
            columns: ["parent_id", "tag"],
          },
        ],
        usesOf: () =>
          new Map([
            ["hosts", { role: "membership" as const }],
            ["ext", { role: "value" as const }],
          ]),
      }),
      membership: {
        kind: "window",
        windowIdsOf: async (p: ResourceParams) =>
          members(Number(p.limit)).map((r) => r.id),
        orderSignatureOf: (r: unknown) => String((r as Row).n),
        limitOf: (p: ResourceParams) => Number(p.limit),
      },
      loader: async (
        p: ResourceParams,
        ctx?: { affectedIds: readonly string[] },
      ) => {
        loads.push(ctx ? [...ctx.affectedIds] : "FULL");
        const rows = ctx
          ? ctx.affectedIds
              .filter((id) => hosts.has(id))
              .map((id) => ({
                id,
                n: hosts.get(id)!,
                tag: ext.get(id) ?? null,
              }))
          : members(Number(p.limit));
        const park = parkNext;
        parkNext = null;
        if (park) await park;
        return rows;
      },
    },
  );
  // Park the NEXT loader run until the returned release is called.
  const parkNextLoad = () => {
    let release!: () => void;
    parkNext = new Promise<void>((r) => (release = r));
    return () => release();
  };
  // The client of one socket, fed the frames recorded from index `from` on.
  const clientOf = (socket: number, from = 0) => {
    const view = makeClientView(keyOf);
    view.applyAll(
      h.frames
        .slice(from)
        .filter((f) => f.key === "win" && f.socket === socket),
    );
    return view.value;
  };
  return { h, hosts, ext, loads, members, parkNextLoad, clientOf, reports };
}

test("a subscriber joining a read that started before a push never regresses the snapshot the push advanced", async () => {
  const f = fixture(3);
  await f.h.subscribe("win", L2); // tab A: [h1, h2], the snapshot seeded
  const release = f.parkNextLoad();
  // Tab B's sub-ack read starts on the old state and parks.
  const subB = f.h.subscribe("win", L2, { socket: 1 });
  await tick();
  // h3 enters: a scoped refill admits it and advances the snapshot.
  f.hosts.set("h3", 0);
  f.h.runtime.routeTableChange({
    source: "feed",
    table: "hosts",
    op: "U",
    ids: ["h3"],
    keys: null,
    unchanged: null,
  });
  await settle();
  // Tab C observes the advanced version and JOINS the parked read.
  const subC = f.h.subscribe("win", L2, { socket: 2 });
  await tick();
  release();
  await subB;
  await subC;
  await settle();

  // A side write to h3 — a member only in the advanced snapshot.
  const before = f.loads.length;
  f.ext.set("h3", "new");
  f.h.runtime.routeTableChange({
    source: "feed",
    table: "hosts_ext",
    op: "U",
    ids: ["h3"],
    keys: { parent_id: ["h3"] },
    unchanged: null,
  });
  await settle();

  expect(f.loads.slice(before)).toEqual([["h3"]]);
  expect(f.clientOf(0)).toEqual(f.members(2));
  expect(f.reports).toEqual([]);
});

test("a drain that outlives the last unsubscribe writes no snapshot back: a re-subscribe's side write during its first load still lands", async () => {
  const f = fixture(1);
  await f.h.subscribe("win", L2); // [h1, h2]
  let release = f.parkNextLoad();
  f.hosts.set("h3", 0);
  f.h.runtime.routeTableChange({
    source: "feed",
    table: "hosts",
    op: "U",
    ids: ["h3"],
    keys: null,
    unchanged: null,
  });
  await tick(); // the drain's refill of h3 parks
  await f.h.unsub("win", L2); // N→0 mid-drain: the snapshot is evicted
  release();
  await settle();
  await settle();

  // Untracked: h4 enters and nothing routes it.
  f.hosts.set("h4", -1);
  const mark = f.h.frames.length;
  release = f.parkNextLoad();
  const resub = f.h.subscribe("win", L2); // its first load reads [h4, h3] and parks
  await tick();
  f.ext.set("h4", "new"); // lands during that load
  f.h.runtime.routeTableChange({
    source: "feed",
    table: "hosts_ext",
    op: "U",
    ids: ["h4"],
    keys: { parent_id: ["h4"] },
    unchanged: null,
  });
  await settle();
  release();
  await resub;
  await settle();
  await settle();

  expect(f.clientOf(0, mark)).toEqual(f.members(2));
  expect(f.reports).toEqual([]);
});
