/**
 * Mutation-ack channel (`ackTx`) on the delta wire. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-ack-channel.test.ts`.
 *
 * A feed change carries its source transaction id (`xid`, the change-feed's
 * `pg_current_xact_id()`); the pending coalesces those into `sourceTx`, and the
 * drain stamps `ackTx` — "the source transactions whose rows this recompute
 * folded in" — onto the value frames it produces (`update` / `delta`). A
 * recompute that produces NO value change (empty scoped diff, membership
 * net-zero / window-boundary skip, point empty-intersection) broadcasts a
 * standalone version-less `{ kind: "ack" }` frame instead, sent only to the
 * subscribers that ASKED for acks on that tuple (`acks: true` on the sub, or
 * `op: "sub-acks"`). Pinned here:
 *
 *   - a feed FULL recompute stamps ackTx on the delta/update; hand-`notify()`
 *     and synthetic pushes are structurally ack-less; `invalidate` never
 *     carries one;
 *   - coalescing unions xids into one frame; a scoped→FULL degrade KEEPS the
 *     union (a FULL reads post-commit — contrast `deleted`, which FULL drops);
 *   - the no-value-change paths send `{ kind: "ack" }` iff a subscriber asked,
 *     only to the sockets whose tabs asked, without bumping the version stream
 *     the next real frame ships under; the request follows the tab (restated by
 *     every sub, flipped by `sub-acks`, dropped with the tab);
 *   - the STALE-FLIGHT REFUSAL: a drain will not be served by a read flight
 *     that started before the notify it is draining, so it always produces its
 *     own value and can always stamp its own ackTx. Co-production made exact —
 *     the "ships un-acked, falls back to the watermark backstop" degrade this
 *     file used to pin is unreachable on the FULL paths
 *     (`research/2026-08-08-global-live-state-flight-freshness.md`);
 *   - loader failure ships neither frame nor ack;
 *   - the SOURCE_TX_CAP overflow suppresses ackTx for the cycle.
 *
 * See research/2026-07-18-global-bounded-working-set-phase2.md Part C.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, snapshotControllable, tick } from "./test-support";
import {
  defineRoutedTable,
  feedChange,
  identityPlan,
  wholeReach,
} from "./testing/routed-fixture";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;

// A keyed own-identity resource "rows" over a simulated table — a routed alias
// (its identity route, the shared fixture), ordered by insertion — with a feed
// helper carrying the optional `xid` attribution. Scoped changes reach an entry
// only through its routes since P8 step 23a.
function keyedHarness() {
  const table = new Map<string, number>();
  const rows = () => [...table.entries()].map(([id, n]) => ({ id, n }));
  const h = createHarness({ sockets: 2 });
  const routed = defineRoutedTable(h, {
    key: "rows",
    table: "row_table",
    membership: "alias",
    schema: rowsSchema,
    loader: (_p, c) =>
      c ? rows().filter((r) => c.affectedIds.includes(r.id)) : rows(),
  });
  const feed = (op: "I" | "U" | "D", ids: string[] | null, xid?: string) =>
    routed.feed(op, ids, xid !== undefined ? { xid } : {});
  return { h, table, feed };
}

const deltas = (h: ReturnType<typeof createHarness>, key: string) =>
  h.pushesFor(key).filter((f) => f.kind === "delta");
const acks = (h: ReturnType<typeof createHarness>, key: string) =>
  h.pushesFor(key).filter((f) => f.kind === "ack");

describe("ackTx — value frames", () => {
  test("a feed FULL recompute stamps ackTx on the keyed delta; a scoped feed change stamps it on the scoped delta", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    await k.h.subscribe("rows");

    // Scoped UPDATE with attribution: the (watermark-less) scoped delta
    // carries the pending's ackTx.
    k.table.set("a", 2);
    k.feed("U", ["a"], "500");
    await tick();
    const scoped = deltas(k.h, "rows").at(-1)!;
    expect(scoped.upserts).toHaveLength(1);
    expect((scoped as { ackTx?: string[] }).ackTx).toEqual(["500"]);

    // FULL (id-less) change: the flight-resolved ackTx rides the FULL delta.
    k.table.set("a", 3);
    k.feed("U", null, "501");
    await tick();
    const full = deltas(k.h, "rows").at(-1)!;
    expect((full as { ackTx?: string[] }).ackTx).toEqual(["501"]);
  });

  test("a feed change without xid (pre-upgrade NOTIFY) ships frames with NO ackTx", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    await k.h.subscribe("rows");
    k.table.set("a", 2);
    k.feed("U", ["a"]);
    await tick();
    const scoped = deltas(k.h, "rows").at(-1)!;
    expect(scoped.upserts).toHaveLength(1);
    expect("ackTx" in scoped).toBe(false);
  });

  test("a push-mode update frame from the feed carries ackTx; hand-notify and synthetic pushes never do", async () => {
    const h = createHarness();
    let n = 0;
    const r = h.runtime.defineExternalResource(
      { key: "p", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReach(["p_table"]),
        loader: async () => ++n,
      },
    );
    await h.subscribe("p");

    feedChange(h, { table: "p_table", op: "U", ids: null, xid: "600" });
    await tick();
    const feedUpdate = h
      .pushesFor("p")
      .filter((f) => f.kind === "update")
      .at(-1)!;
    expect((feedUpdate as { ackTx?: string[] }).ackTx).toEqual(["600"]);

    // Hand-`notify()`: no HTTP mutation corresponds — structurally ack-less.
    r.notify();
    await tick();
    const handUpdate = h
      .pushesFor("p")
      .filter((f) => f.kind === "update")
      .at(-1)!;
    expect("ackTx" in handUpdate).toBe(false);

    // Synthetic (debug churn emitter): same.
    h.runtime.triggerResourcePush("p");
    await tick();
    const synthUpdate = h
      .pushesFor("p")
      .filter((f) => f.kind === "update")
      .at(-1)!;
    expect("ackTx" in synthUpdate).toBe(false);
  });

  // The upstream's change xids ride the FULL `dependsOn` cascade: the
  // downstream recompute folds in the same source transactions, so its frame
  // acks them too (`cascadeSourceTx` → `cascadeDownstream`'s merge). An
  // overflowed upstream forwards nothing — a torn set is worse than none.
  function cascadeHarness() {
    const h = createHarness();
    let u = 0;
    let d = 0;
    const up = h.runtime.defineExternalResource(
      { key: "up", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReach(["up_table"]),
        loader: async () => ++u,
      },
    );
    h.runtime.defineResource({
      key: "down",
      mode: "push",
      schema: z.number(),
      loader: async () => ++d,
      dependsOn: [{ resource: up }],
    });
    return h;
  }
  const lastUpdate = (h: ReturnType<typeof createHarness>, key: string) =>
    h
      .pushesFor(key)
      .filter((f) => f.kind === "update")
      .at(-1) as { ackTx?: string[] } | undefined;

  test("a dependsOn cascade forwards the upstream's xids onto the downstream's frame", async () => {
    const h = cascadeHarness();
    await h.subscribe("up");
    await h.subscribe("down");
    feedChange(h, { table: "up_table", op: "U", ids: null, xid: "42" });
    await tick();
    expect(lastUpdate(h, "up")?.ackTx).toEqual(["42"]);
    expect(lastUpdate(h, "down")?.ackTx).toEqual(["42"]);
  });

  test("an overflowed upstream (> 64 xids) forwards no ackTx down the cascade", async () => {
    const h = cascadeHarness();
    await h.subscribe("up");
    await h.subscribe("down");
    for (let i = 0; i < 65; i++)
      feedChange(h, {
        table: "up_table",
        op: "U",
        ids: null,
        xid: `${3000 + i}`,
      });
    await tick();
    // Both frames ship (the cascade ran); neither carries a torn set.
    const upFrame = lastUpdate(h, "up");
    const downFrame = lastUpdate(h, "down");
    expect(upFrame).toBeDefined();
    expect(downFrame).toBeDefined();
    expect("ackTx" in upFrame!).toBe(false);
    expect("ackTx" in downFrame!).toBe(false);
  });

  test("invalidate frames NEVER carry ackTx (the base does not yet reflect the tx)", async () => {
    const h = createHarness();
    h.runtime.defineExternalResource(
      { key: "i", schema: z.number(), validateParams: () => {} },
      {
        mode: "invalidate",
        reach: wholeReach(["i_table"]),
        loader: async () => 1,
      },
    );
    await h.subscribe("i");
    feedChange(h, { table: "i_table", op: "U", ids: null, xid: "700" });
    await tick();
    const inv = h
      .pushesFor("i")
      .filter((f) => f.kind === "invalidate")
      .at(-1)!;
    expect("ackTx" in inv).toBe(false);
  });

  test("sub-ack and the HTTP body never carry ackTx (their snapshot watermark subsumes it)", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    await k.h.subscribe("rows");
    const ack = k.h.frames.find((f) => f.kind === "sub-ack")!;
    expect("ackTx" in ack).toBe(false);

    const res = await k.h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/rows"),
      { key: "rows" },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect("ackTx" in body).toBe(false);
  });
});

describe("ackTx — coalescing", () => {
  test("two same-flush xids union into ONE frame carrying both", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    k.table.set("b", 1);
    await k.h.subscribe("rows");
    k.table.set("a", 2);
    k.table.set("b", 2);
    k.feed("U", ["a"], "800");
    k.feed("U", ["b"], "801");
    await tick();
    const all = deltas(k.h, "rows");
    expect(all).toHaveLength(1); // coalesced into one flush
    expect([...((all[0] as { ackTx?: string[] }).ackTx ?? [])].sort()).toEqual([
      "800",
      "801",
    ]);
  });

  test("a scoped→FULL degrade KEEPS the union (contrast `deleted`, which FULL drops)", async () => {
    // An M5 membership entry so a DELETE populates the pending's `deleted`
    // channel; the id-less follow-up degrades the pk to FULL, which drops
    // `deleted` (the FULL rebuild resolves membership wholesale) but must keep
    // BOTH sourceTx claims — the FULL read is post-commit for both.
    const table = new Map<string, number>();
    const rows = () => [...table.entries()].map(([id, n]) => ({ id, n }));
    const h = createHarness();
    h.runtime.defineResource(
      {
        key: "m",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: identityPlan("m_table"),
        scopedMembership: {
          orderOf: async () => [...table.keys()],
          orderSignatureOf: () => "",
        },
        loader: (_p, c) =>
          c ? rows().filter((r) => c.affectedIds.includes(r.id)) : rows(),
      },
    );
    const feed = (op: "I" | "U" | "D", ids: string[] | null, xid: string) =>
      feedChange(h, {
        table: "m_table",
        op,
        ids,
        xid,
      });
    table.set("a", 1);
    table.set("b", 1);
    await h.subscribe("m");

    table.delete("a");
    feed("D", ["a"], "900"); // membership DELETE → `deleted` channel
    table.set("b", 2);
    feed("U", null, "901"); // id-less → degrade the SAME pending to FULL
    await tick();
    const frame = deltas(h, "m").at(-1)!;
    // FULL membership rebuild: the delete shipped via the rebuilt order, and
    // the ackTx union survived the degrade.
    expect(frame.order).toEqual(["b"]);
    expect([...((frame as { ackTx?: string[] }).ackTx ?? [])].sort()).toEqual([
      "900",
      "901",
    ]);
  });
});

describe("standalone ack frames — no-value-change recomputes", () => {
  test("an empty scoped diff sends { kind: 'ack' } iff the subscriber asked — version-less, no value frame", async () => {
    // Asked: a byte-identical rewrite (the loader returns the same row) diffs
    // to empty — no delta, but the writer's ack ships standalone.
    const optIn = keyedHarness();
    optIn.table.set("a", 1);
    await optIn.h.subscribe("rows", {}, { acks: true });
    optIn.feed("U", ["a"], "1000"); // no byte change
    await tick();
    expect(deltas(optIn.h, "rows")).toHaveLength(0);
    const ack = acks(optIn.h, "rows");
    expect(ack).toHaveLength(1);
    expect((ack[0] as { ackTx?: string[] }).ackTx).toEqual(["1000"]);
    expect("version" in ack[0]!).toBe(false); // version-less by design

    // Did not ask: the same recompute ships nothing at all.
    const optOut = keyedHarness();
    optOut.table.set("a", 1);
    await optOut.h.subscribe("rows");
    optOut.feed("U", ["a"], "1001");
    await tick();
    expect(optOut.h.pushesFor("rows")).toHaveLength(0);
  });

  test("point empty-intersection sends an ack to the untouched tuple iff it asked, with NO version bump", async () => {
    const makePoint = () => {
      const table = new Map<string, number>();
      const idsOf = (p: Record<string, string>) =>
        (p.ids ?? "").split(",").filter(Boolean);
      const h = createHarness();
      h.runtime.defineResource(
        {
          key: "pt",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        {
          routes: identityPlan("pt_table"),
          membership: { kind: "point", idsOf },
          loader: (p, c) => {
            const ids = c ? [...c.affectedIds] : idsOf(p);
            return ids
              .filter((id) => table.has(id))
              .map((id) => ({ id, n: table.get(id)! }));
          },
        },
      );
      const feed = (op: "I" | "U" | "D", ids: string[] | null, xid?: string) =>
        feedChange(h, {
          table: "pt_table",
          op,
          ids,
          ...(xid !== undefined ? { xid } : {}),
        });
      return { h, table, feed };
    };

    const p = makePoint();
    p.table.set("a", 1);
    await p.h.subscribe("pt", { ids: "a" }, { acks: true });
    const base = p.h.frames.find((f) => f.kind === "sub-ack")!.version!;

    // A change entirely OUTSIDE the tuple's id set: value untouched, ack ships.
    p.table.set("z", 9);
    p.feed("U", ["z"], "1100");
    await tick();
    expect(deltas(p.h, "pt")).toHaveLength(0);
    const ack = acks(p.h, "pt");
    expect(ack).toHaveLength(1);
    expect((ack[0] as { ackTx?: string[] }).ackTx).toEqual(["1100"]);
    expect(ack[0]!.params).toEqual({ ids: "a" });

    // The ack-only cycle bumped NO version: the first real change ships at the
    // sub-ack's version + 1.
    p.table.set("a", 2);
    p.feed("U", ["a"], "1101");
    await tick();
    expect(deltas(p.h, "pt").at(-1)!.version).toBe(base + 1);

    // Nobody asked: the empty intersection stays a total no-op.
    const q = makePoint();
    q.table.set("a", 1);
    await q.h.subscribe("pt", { ids: "a" });
    q.table.set("z", 9);
    q.feed("U", ["z"], "1102");
    await tick();
    expect(q.h.pushesFor("pt")).toHaveLength(0);
  });

  test("a window-boundary skip (entrant past the tail) sends an ack, with NO version bump", async () => {
    const table = new Map<string, number>(); // id → n; window = 2 smallest n
    const members = () =>
      [...table.entries()]
        .map(([id, n]) => ({ id, n }))
        .sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));
    const h = createHarness();
    h.runtime.defineResource(
      {
        key: "win",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: identityPlan("w_table"),
        membership: {
          kind: "window",
          windowIdsOf: async () =>
            members()
              .slice(0, 2)
              .map((r) => r.id),
          limitOf: () => 2,
        },
        loader: (_p, c) =>
          c
            ? [...c.affectedIds]
                .filter((id) => table.has(id))
                .map((id) => ({ id, n: table.get(id)! }))
            : members().slice(0, 2),
      },
    );
    const feed = (op: "I" | "U" | "D", ids: string[] | null, xid: string) =>
      feedChange(h, {
        table: "w_table",
        op,
        ids,
        xid,
      });
    table.set("a", 1);
    table.set("b", 2);
    await h.subscribe("win", {}, { acks: true }); // window [a, b]
    const base = h.frames.find((f) => f.kind === "sub-ack")!.version!;

    // Entrant sorting PAST the tail: net-zero — no frame, but the ack ships.
    table.set("z", 9);
    feed("I", ["z"], "1200");
    await tick();
    expect(deltas(h, "win")).toHaveLength(0);
    expect(
      (acks(h, "win").at(-1) as { ackTx?: string[] } | undefined)?.ackTx,
    ).toEqual(["1200"]);

    // No version was consumed: the first real change ships at the sub-ack's
    // version + 1.
    table.set("a", 0);
    feed("U", ["a"], "1201");
    await tick();
    expect(deltas(h, "win").at(-1)!.version).toBe(base + 1);
  });

  test("an ack frame reaches only subscribers of the tuple; zero subscribers ⇒ nothing", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    await k.h.subscribe("rows", {}, { socket: 0, acks: true });
    k.feed("U", ["a"], "1300"); // empty diff → ack
    await tick();
    expect(acks(k.h, "rows").filter((f) => f.socket === 0)).toHaveLength(1);
    expect(acks(k.h, "rows").filter((f) => f.socket === 1)).toHaveLength(0);
  });

  test("an ack frame reaches only the subscriptions that asked — not a co-subscriber of the same tuple", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    await k.h.subscribe("rows", {}, { socket: 0, acks: true });
    await k.h.subscribe("rows", {}, { socket: 1 });
    k.feed("U", ["a"], "1310"); // empty diff → ack
    await tick();
    expect(acks(k.h, "rows").filter((f) => f.socket === 0)).toHaveLength(1);
    expect(acks(k.h, "rows").filter((f) => f.socket === 1)).toHaveLength(0);
  });

  test("the request is OR-ed across the tabs sharing a socket and follows each tab", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    const feedNoop = () => k.feed("U", ["a"], String(++xid)); // empty diff each time
    let xid = 1320;
    const acked = () => acks(k.h, "rows").length;
    await k.h.subscribe("rows", {}, { tabId: "t1", acks: true });
    await k.h.subscribe("rows", {}, { tabId: "t2" });
    feedNoop();
    await tick();
    expect(acked()).toBe(1); // t1 asked → the socket gets it (once)

    // t2 asks too, then t1 stops asking: still delivered (t2 wants it).
    await k.h.subscribe("rows", {}, { tabId: "t2", acks: true });
    await k.h.subAcks("rows", {}, false, { tabId: "t1" });
    feedNoop();
    await tick();
    expect(acked()).toBe(2);

    // t2's own restating sub without `acks` turns it off: nobody asks now.
    await k.h.subscribe("rows", {}, { tabId: "t2" });
    feedNoop();
    await tick();
    expect(acked()).toBe(2);

    // `sub-acks` turns it back on without a new sub-ack…
    const subAcksBefore = k.h.frames.filter((f) => f.kind === "sub-ack").length;
    await k.h.subAcks("rows", {}, true, { tabId: "t1" });
    expect(k.h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(
      subAcksBefore,
    );
    feedNoop();
    await tick();
    expect(acked()).toBe(3);

    // …and the asking tab's departure takes its request with it, even though
    // the other tab still holds the sub.
    await k.h.unsubTab("t1");
    feedNoop();
    await tick();
    expect(acked()).toBe(3);
  });

  test("a sub-acks frame for a tuple the tab does not hold is dropped", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    await k.h.subscribe("rows", {}, { tabId: "t1" });
    await k.h.subAcks("rows", {}, true, { tabId: "t2" });
    k.feed("U", ["a"], "1340");
    await tick();
    expect(acks(k.h, "rows")).toHaveLength(0);
    // Positive control: the holding tab's own request is honoured.
    await k.h.subAcks("rows", {}, true, { tabId: "t1" });
    k.feed("U", ["a"], "1341");
    await tick();
    expect(acks(k.h, "rows")).toHaveLength(1);
  });

  test("a sub-batch entry restates the tab's request", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    await k.h.subscribeBatch([{ key: "rows", acks: true }], { tabId: "t1" });
    k.feed("U", ["a"], "1350");
    await tick();
    expect(acks(k.h, "rows")).toHaveLength(1);
    await k.h.subscribeBatch([{ key: "rows" }], { tabId: "t1" });
    k.feed("U", ["a"], "1351");
    await tick();
    expect(acks(k.h, "rows")).toHaveLength(1);
  });
});

describe("ackTx — stale-flight REFUSAL (co-production made exact)", () => {
  test("a drain refuses a read flight older than its notify, so it produces its own value and stamps its own ackTx", async () => {
    // This case used to pin the opposite — the drain COALESCED onto the parked
    // read and shipped the value un-acked, "safe because a missed ack degrades to
    // the watermark backstop". That reading was wrong about which stamp was at
    // risk: `ackTx` was co-produced, but the VERSION was not, so the frame
    // announced a pre-commit value as the newest state (the 2026-08-08 revert).
    // The drain now refuses such a flight and runs its own read, which makes the
    // ack exact as a by-product.
    //
    // `snapshotControllable`, not `controllable`: the loader must capture its rows
    // at INVOCATION time, or the parked flight and a fresh one return the same
    // value and the test cannot tell a join from a refusal. That is exactly how
    // this case read green while pinning the bug.
    const ctl = snapshotControllable([{ id: "a", n: 1 }]);
    const h = createHarness({ sockets: 2 });
    const c = defineRoutedTable(h, {
      key: "c",
      table: "c_table",
      membership: "alias",
      schema: rowsSchema,
      orderOf: async () => ["a"],
      loader: ctl.loader,
    });
    await h.subscribe("c", {}, { socket: 0 }); // seeds the snapshot

    // Park a READ flight (socket 1's full-path sub) holding the PRE-commit rows,
    // then land a feed change.
    ctl.block();
    const p = h.subscribe("c", {}, { socket: 1 });
    await tick(); // the pre-commit read is in the air
    ctl.setValue([{ id: "a", n: 2 }]);
    c.feed("U", null, { xid: "1400" }); // unknown rows: the FULL drain
    await tick(); // the drain runs — and refuses the parked flight
    ctl.release();
    await p;
    await tick();

    const own = deltas(h, "c").at(-1)!;
    expect(own.upserts).toEqual([["a", { id: "a", n: 2 }]]); // POST-commit rows
    // Its own flight read post-commit, so the ack is exact rather than absent.
    expect((own as { ackTx?: string[] }).ackTx).toEqual(["1400"]);

    // And an idle-time FULL change — nothing in flight to refuse — is unchanged.
    ctl.setValue([{ id: "a", n: 3 }]);
    c.feed("U", null, { xid: "1401" });
    await tick();
    expect((deltas(h, "c").at(-1) as { ackTx?: string[] }).ackTx).toEqual([
      "1401",
    ]);
  });
});

describe("ackTx — failure and overflow", () => {
  test("loader failure ships neither a frame nor an ack (no false ack)", async () => {
    const h = createHarness();
    let boom = false;
    const f = defineRoutedTable(h, {
      key: "f",
      table: "f_table",
      membership: "alias",
      schema: rowsSchema,
      orderOf: async () => ["a"],
      loader: async () => {
        if (boom) throw new Error("loader boom");
        return [{ id: "a", n: 1 }];
      },
    });
    await h.subscribe("f", {}, { acks: true });
    boom = true;
    f.feed("U", null, { xid: "1500" });
    await tick();
    expect(h.pushesFor("f")).toHaveLength(0);
    // Positive control: the same change once the loader recovers ships its
    // frame with the ack.
    boom = false;
    f.feed("U", null, { xid: "1501" });
    await tick();
    expect(
      h.pushesFor("f").map((x) => (x as { ackTx?: string[] }).ackTx),
    ).toEqual([["1501"]]);
  });

  test("crossing the sourceTx cap (64) suppresses ackTx for the whole cycle", async () => {
    const k = keyedHarness();
    k.table.set("a", 1);
    await k.h.subscribe("rows", {}, { acks: true });
    k.table.set("a", 2); // real byte change → a delta ships
    for (let i = 0; i < 65; i++) k.feed("U", ["a"], `${2000 + i}`);
    await tick();
    const frame = deltas(k.h, "rows").at(-1)!;
    expect(frame.upserts).toHaveLength(1); // the value frame is untouched
    expect("ackTx" in frame).toBe(false); // a torn set is worse than none
    expect(acks(k.h, "rows")).toHaveLength(0); // suppression covers the ack frame too
  });
});
