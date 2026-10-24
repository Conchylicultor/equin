/**
 * H5 — the notify-vs-fresh-sub race. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-h5.test.ts`.
 *
 * `research/2026-04-15-global-sse-lifecycle-mental-model-v3.md` §9 (H5) prescribes
 * "test by racing a `notify()` against a fresh `sub` in a unit test". A fresh
 * subscription reads its sub-ack version up front — the fresh one its
 * registration opened the tuple's tracking span with; the read itself never
 * bumps (`serveSub`) — and then parks on the loader; meanwhile a concurrent push
 * bumps the version and ships a newer frame. The invariant the client leans on:
 * the stale sub-ack (older version) can NEVER overwrite the newer push, because
 * the WS version guard applies a frame iff `frame.version > entry.version`
 * (`notifications-client.ts:862`). These tests drive the recorded frames through
 * the real client simulator (`makeClientView`) and assert it converges to server
 * truth — not merely that a frame of the right shape was sent.
 *
 * These races no longer COALESCE, and the file's old argument rested on the fact
 * that they did. Since `research/2026-08-08-global-live-state-flight-freshness.md`
 * a push drain passes a freshness floor (`notBefore: lastNotifyAt`) into the
 * single-flight, so a read flight that started before the notify is SUPERSEDED,
 * not joined: H5a and H5c each run the FULL loader TWICE and fire the runtime's
 * `onStaleFlightSupersede` hook once. They stay green — and the reasons are
 * recorded per test, because "still green" was never the interesting part. The
 * bug that incident was about hid inside a suite that was green for a reason that
 * had stopped being true.
 *
 * What survives unchanged: `handleSub` yields one explicit microtask after its
 * flight resolves while `sendUpdate` sends synchronously (see
 * `resource-runtime/CLAUDE.md`), so the push still reaches the wire before the
 * stale sub-ack in this harness. That is an ordering these tests OBSERVE, not an
 * invariant the wire depends on — with two independent flights, real completion
 * order is unrelated — and every convergence assertion below holds in either
 * order, because the client's version guard, not the send order, is what makes the
 * stale sub-ack harmless.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  controllable,
  tick,
  makeClientView,
} from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;

describe("H5 — notify races a fresh sub", () => {
  test("H5a: a push landing while a fresh sub's loader is parked wins; the stale sub-ack is version-dropped", async () => {
    const supersedes: string[] = [];
    const h = createHarness({
      onStaleFlightSupersede: (key) => supersedes.push(key),
    });
    const ctl = controllable("A");
    let loads = 0;
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: () => {
        loads++;
        return ctl.loader();
      },
    });

    // Fresh subscribe whose loader parks. Registration (refcount + sub entry) is
    // synchronous — before the loader await — so this socket IS a subscriber by
    // the time the notify flushes, and the sub-ack's version (the fresh one its
    // tracking span opened with) is read up front.
    ctl.block();
    ctl.setValue("B");
    await h.subscribe("r"); // sub-ack parked on the blocked loader
    expect(h.frames).toHaveLength(0); // nothing sent yet

    // Notify while parked: the flush bumps the version past the sub-ack's one
    // and starts its OWN
    // load — the parked sub's flight began before this notify, so the drain
    // refuses it (freshness floor). Both loads park on the same block, so no
    // frame is sent until release. Pre-2026-08-08 the drain joined the sub's
    // flight here and only one load ran; `controllable` resolves both to "B"
    // either way, which is why this test cannot see the difference and
    // `runtime-stale-flight.test.ts` exists.
    r.notify();
    await tick();
    expect(h.frames).toHaveLength(0);
    expect(supersedes).toEqual(["r"]); // refused, not joined
    expect(loads).toBe(2); // …so two loads are in the air, both parked

    ctl.release();
    await tick();

    // Two frames: the push (update at base + 1) sent BEFORE the stale sub-ack
    // (at base, the version it read before parking) — the race. The sub-ack's
    // version is not strictly greater than the push's, so the client
    // version-drops it.
    const update = h.frames.find((f) => f.kind === "update")!;
    const subAck = h.frames.find((f) => f.kind === "sub-ack")!;
    const base = subAck.version!;
    expect(update.version).toBe(base + 1);
    expect(update.value).toBe("B");
    // Send order, not a wire invariant: `sendUpdate` broadcasts with no await
    // while `handleSub` yields a microtask after its flight, so the push wins in
    // this harness. It guards that no-await property (the reason `sendUpdate`
    // sends rather than returns a frame — `runtime-revalidate.test.ts` owns the
    // dedicated case), NOT the correctness below: the version guard makes the
    // stale sub-ack harmless whichever order it arrives in.
    expect(update.seq).toBeLessThan(subAck.seq);

    // The real client, fed the frames in send order, converges to the LATEST
    // loader output at the push's version — the stale sub-ack changes nothing.
    const cv = makeClientView();
    cv.applyAll(h.frames);
    expect(cv.value).toBe("B");
    expect(cv.version).toBe(base + 1); // monotonic — never regressed to the sub-ack's
    expect(cv.driftResubs).toBe(0);
  });

  test("H5b: reverse ordering (sub completes, THEN a notify) also converges", async () => {
    const h = createHarness();
    const ctl = controllable("A");
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: ctl.loader,
    });

    await h.subscribe("r"); // sub-ack at the span's fresh version, value A
    const base = h.frames.find((f) => f.kind === "sub-ack")!.version!;
    ctl.setValue("B");
    r.notify(); // now a real change
    await tick();

    const cv = makeClientView();
    cv.applyAll(h.frames);
    expect(cv.value).toBe("B");
    expect(cv.version).toBe(base + 1);
    expect(cv.driftResubs).toBe(0);
    // sub-ack (base) then update (base + 1) — versions strictly increasing in
    // send order.
    expect(h.frames.map((f) => f.version)).toEqual([base, base + 1]);
  });

  test("H5c: keyed — a fresh sub races a FULL update, then a subsequent delta merges without drift", async () => {
    // The deep one. Exercises `serveSub`'s keyed snapshot-seed against a
    // concurrent higher-versioned FULL push that already advanced the server
    // snapshot.
    //
    // Two rationales for it are DEAD. "The two FULL loads coalesce, so the
    // sub-ack re-seeds the identical id→hash" died when the push drain began
    // refusing the sub's older flight (two loads run, asserted below). Its
    // successor — "a read flight is never newer than the push's, so a re-seed
    // can only regress the base to an older one, which ships extra rows, never
    // missing ones" — was false too: a read that runs after a commit whose
    // NOTIFY has not drained yet IS newer, and re-seeding it at the same version
    // swallowed that commit's delta for every earlier holder
    // (`runtime-reseed-ahead.test.ts`).
    //
    // What holds now: the sub-ack seeds only a tuple with NO snapshot. Here the
    // push's FULL update seeded it first, so the stale sub-ack's value is never
    // a base at all, and the next delta diffs against the push's.
    const supersedes: string[] = [];
    let fullLoads = 0;
    const h = createHarness({
      onStaleFlightSupersede: (key) => supersedes.push(key),
    });
    const ctl = controllable<{ id: string; n: number }[]>([
      { id: "a", n: 1 },
      { id: "b", n: 1 },
    ]);
    // A routed alias over the identity table (the shared fixture).
    const rows = defineRoutedTable(h, {
      key: "rows",
      table: "row_table",
      membership: "alias",
      schema: rowsSchema,
      orderOf: async () => ctl.value.map((row) => row.id),
      // FULL and (later) scoped both read the same controllable value; the
      // scoped ctx narrows to the affected rows.
      loader: (_p, c) => {
        if (!c) fullLoads++;
        return c
          ? ctl.value.filter((row) => c.affectedIds.includes(row.id))
          : ctl.loader();
      },
    });

    // Fresh subscribe parks; a FULL feed change (INSERT → ids null) races it.
    ctl.block();
    ctl.setValue([
      { id: "a", n: 2 },
      { id: "b", n: 1 },
    ]);
    await h.subscribe("rows"); // sub-ack parked
    rows.feed("I", null);
    await tick();
    ctl.release();
    await tick();

    // The mechanism, pinned so the rationale above stays checkable: the drain
    // REFUSED the sub's older flight (one supersession) and ran its own FULL
    // load, so two FULL loads happened here — they did NOT coalesce.
    expect(supersedes).toEqual(["rows"]);
    expect(fullLoads).toBe(2);

    // First race: a FULL update (base + 1) before the stale sub-ack (base, the
    // version it read before parking).
    const staleAck = h.frames.find((f) => f.kind === "sub-ack")!;
    const base = staleAck.version!;
    const firstUpdate = h.frames.find((f) => f.kind === "update")!;
    expect(firstUpdate.version).toBe(base + 1);

    // A SUBSEQUENT scoped change ships a delta the client must merge onto the
    // push's base, which the stale sub-ack left in place. No drift.
    ctl.setValue([
      { id: "a", n: 3 },
      { id: "b", n: 1 },
    ]);
    rows.feed("U", null);
    await tick();

    const deltas = h.pushesFor("rows").filter((f) => f.kind === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.version).toBe(base + 2);

    // The client, fed every frame, converges to server truth: a=3 (from the delta)
    // and b=1, at base + 2, with zero drift-resubs (the base was never missing).
    const cv = makeClientView(keyOf);
    cv.applyAll(h.frames);
    expect(cv.value).toEqual([
      { id: "a", n: 3 },
      { id: "b", n: 1 },
    ]);
    expect(cv.version).toBe(base + 2);
    expect(cv.driftResubs).toBe(0);
  });

  test("H5d: a second socket subscribing mid-flush costs the first socket no frame", async () => {
    const h = createHarness({ sockets: 2 });
    const ctl = controllable(0);
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.number(),
      loader: ctl.loader,
    });

    await h.subscribe("r", {}, { socket: 0 }); // A: sub-ack at the span's version
    const base = h.frames.find((f) => f.kind === "sub-ack")!.version!;
    // Block, notify → the flush parks on A's push load (version already bumped
    // to base + 1).
    ctl.block();
    ctl.setValue(9);
    r.notify();
    await tick(); // flush is mid-await

    // B subscribes mid-flush; its sub-ack coalesces onto the same blocked load.
    await h.subscribe("r", {}, { socket: 1 });
    ctl.release();
    await tick();

    // A lost no frame: it still received exactly its push (update at base + 1).
    const aPushes = h.pushesFor("r", 0);
    expect(aPushes).toHaveLength(1);
    expect(aPushes[0]!.kind).toBe("update");
    expect(aPushes[0]!.version).toBe(base + 1);

    // Both sockets' clients converge to the same server truth (value 9 at
    // base + 1). B joined A's tracking span, so its sub opened no new one.
    const a = makeClientView();
    a.applyAll(h.framesFor(0));
    const b = makeClientView();
    b.applyAll(h.framesFor(1));
    expect(a.value).toBe(9);
    expect(a.version).toBe(base + 1);
    expect(b.value).toBe(9);
    expect(b.version).toBe(base + 1); // B read the already-bumped version at its mid-flush sub
  });
});
