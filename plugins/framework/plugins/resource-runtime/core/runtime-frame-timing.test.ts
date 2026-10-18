/**
 * `timing` — `{changedAt, sentAt, deliverMs}` on pushed value frames, so an open
 * tab can split change → applied into server and transport layers on a clock the
 * serving thread does not own; and `changedAt` beside it on `onDelivered`. Run
 * with `./singularity test plugins/framework/plugins/resource-runtime`.
 *
 * Observability only: no runtime decision reads it. What is pinned here is what a
 * latency reader depends on — a frame carries `timing` exactly when its pending
 * knows a change time; the EARLIEST change of a coalesced pending wins; a hand
 * `notify()` stamps its own call time; keyed deltas (FULL and scoped) carry it
 * too; and a frame with no change behind it (sub-ack, a time-less replay)
 * carries none — and then `onDelivered` reports no `changedAt` either.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  tick,
  type Harness,
  type RecordedFrame,
} from "./test-support";
import { defineRoutedTable, wholeReach } from "./testing/routed-fixture";
import type { ResourceDelivery } from "./runtime";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));

function pushedSince(h: { frames: RecordedFrame[] }, before: number) {
  return h.frames
    .slice(before)
    .filter((f) => f.kind === "update" || f.kind === "delta");
}

// A push value reading table `t` whole (a reach plan), as a served db value is.
function defineR(h: Harness): void {
  h.runtime.defineResource(
    { key: "r", schema: z.number(), validateParams: () => {} },
    { mode: "push", reach: wholeReach(["t"]), loader: async () => 1 },
  );
}

describe("timing on pushed frames", () => {
  test("a feed-driven update carries the earliest change time of the changes it coalesced", async () => {
    const delivered: ResourceDelivery[] = [];
    const h = createHarness({
      onDelivered: (_key, info) => delivered.push(info),
    });
    defineR(h);
    await h.subscribe("r");
    const before = h.frames.length;
    const t0 = Date.now();

    // Two changes land in one pending before the flush: later first, earlier second.
    for (const changedAt of [2_000, 1_000]) {
      h.runtime.routeTableChange({
        source: "feed",
        table: "t",
        op: "U",
        ids: null,
        keys: null,
        unchanged: null,
        changedAt,
      });
    }
    await tick();

    const updates = pushedSince(h, before);
    expect(updates).toHaveLength(1);
    const timing = updates[0]!.timing!;
    expect(timing.changedAt).toBe(1_000);
    expect(timing.sentAt).toBeGreaterThanOrEqual(t0);
    expect(timing.sentAt).toBeLessThanOrEqual(Date.now());
    expect(timing.deliverMs).toBeGreaterThanOrEqual(0);
    // onDelivered reports the same earliest change beside its latency.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.changedAt).toBe(1_000);
    expect(delivered[0]!.latencyMs).toBeGreaterThanOrEqual(timing.deliverMs);
  });

  test("the sub-ack that answers a subscribe carries no timing", async () => {
    const h = createHarness();
    defineR(h);
    await h.subscribe("r");
    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks).toHaveLength(1);
    expect("timing" in acks[0]!).toBe(false);
    expect("changedAt" in acks[0]!).toBe(false);
  });

  test("a hand notify() of an external resource stamps the time of the call", async () => {
    const h = createHarness();
    const r = h.runtime.defineExternalResource({
      key: "ext",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("ext");
    const before = h.frames.length;
    const t0 = Date.now();
    r.notify();
    await tick();
    const timing = pushedSince(h, before)[0]?.timing;
    expect(timing?.changedAt).toBeGreaterThanOrEqual(t0);
    expect(timing?.sentAt).toBeGreaterThanOrEqual(timing!.changedAt);
    expect(timing?.sentAt).toBeLessThanOrEqual(Date.now());
  });

  test("a change with no time (catch-up replay, pre-upgrade NOTIFY) ships a frame without timing", async () => {
    const delivered: ResourceDelivery[] = [];
    const h = createHarness({
      onDelivered: (_key, info) => delivered.push(info),
    });
    defineR(h);
    await h.subscribe("r");
    const before = h.frames.length;
    h.runtime.routeTableChange({
      source: "feed",
      table: "t",
      op: "U",
      ids: null,
      keys: null,
      unchanged: null,
    });
    await tick();
    const update = pushedSince(h, before)[0];
    expect(update?.kind).toBe("update");
    expect("timing" in update!).toBe(false);
    expect(delivered).toHaveLength(1);
    expect("changedAt" in delivered[0]!).toBe(false);
  });

  describe("keyed deltas", () => {
    function keyedRows() {
      const h = createHarness();
      const truth = [
        { id: "a", n: 1 },
        { id: "b", n: 1 },
      ];
      const rows = defineRoutedTable(h, {
        key: "rows",
        table: "row_table",
        membership: "alias",
        schema: rowsSchema,
        loader: (_p, c) =>
          c ? truth.filter((r) => c.affectedIds.includes(r.id)) : truth,
      });
      return { h, rows, truth };
    }

    test("a scoped change's delta carries the change time", async () => {
      const { h, rows, truth } = keyedRows();
      await h.subscribe("rows");
      const before = h.frames.length;
      truth[0]!.n = 2;
      rows.feed("U", ["a"], { changedAt: 1_500 });
      await tick();
      const deltas = pushedSince(h, before);
      expect(deltas.map((f) => f.kind)).toEqual(["delta"]);
      expect(deltas[0]!.timing?.changedAt).toBe(1_500);
    });

    test("an id-less change's FULL keyed delta carries the change time", async () => {
      const { h, rows, truth } = keyedRows();
      await h.subscribe("rows");
      const before = h.frames.length;
      truth[1]!.n = 3;
      rows.feed("U", null, { changedAt: 2_500 });
      await tick();
      const deltas = pushedSince(h, before);
      expect(deltas.map((f) => f.kind)).toEqual(["delta"]);
      expect(deltas[0]!.timing?.changedAt).toBe(2_500);
    });

    test("a replayed change with no time ships a delta without timing", async () => {
      const { h, rows, truth } = keyedRows();
      await h.subscribe("rows");
      const before = h.frames.length;
      truth[0]!.n = 4;
      rows.feed("U", ["a"]);
      await tick();
      const deltas = pushedSince(h, before);
      expect(deltas.map((f) => f.kind)).toEqual(["delta"]);
      expect("timing" in deltas[0]!).toBe(false);
    });
  });
});
