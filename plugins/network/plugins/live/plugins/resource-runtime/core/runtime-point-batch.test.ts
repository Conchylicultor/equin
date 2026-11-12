/**
 * Batched cold point reads (`PointBatch`): a tuple's read that finds another
 * tuple of its family still queued at the read-admission gate rides that read
 * — one slot, one loader run over the union of the ids — and each tuple is
 * served the rows of its own ids.
 *
 * From the 2026-11-08 24 h after-audit (§2.3): after every main restart each
 * reconnecting tab resubscribed one `tasks.v2:rows` tuple per task chip, each
 * a separate ~100 ms read holding one of six slots, so ~120 reads queued ~2 s.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  controllable,
  tick,
  type Harness,
} from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";

type Row = { id: string };

/** Six parked reads on two other keys: every read-admission slot held. */
function fillGate(h: Harness) {
  const ctl = controllable("v");
  for (const key of ["slow-a", "slow-b"]) {
    h.runtime.defineExternalResource<string, { i: string }>({
      key,
      mode: "push",
      schema: z.string(),
      loader: () => ctl.loader(),
    });
  }
  ctl.block();
  return {
    ctl,
    async fill() {
      for (const key of ["slow-a", "slow-b"])
        for (let i = 0; i < 3; i++) await h.subscribe(key, { i: String(i) });
      expect(h.runtime.readGateStats().active).toBe(6);
    },
  };
}

/** A routed point set over `rows`; every loader call is recorded. */
function defineRows(
  h: Harness,
  o: { maxIds?: number; batch?: boolean; fail?: boolean } = {},
) {
  // The database's spelling rule: an id matches the row named by its
  // lower-case spelling (as a uuid column matches an upper-case uuid), so
  // only a lower-case id is the key a row is served under.
  const calls: Array<{ params: string; ids: readonly string[] | null }> = [];
  defineRoutedTable<Row>(h, {
    key: "rows",
    table: "rows",
    membership: "point",
    loader: (params, ctx) => {
      calls.push({ params: params.ids ?? "", ids: ctx?.affectedIds ?? null });
      if (o.fail) throw new Error("boom");
      const ids = ctx?.affectedIds ?? (params.ids ?? "").split(",");
      // `missing` names no row, as an unknown id reads.
      return ids
        .filter((id) => id.toLowerCase() !== "missing")
        .map((id) => ({ id: id.toLowerCase() }));
    },
    ...(o.batch === false
      ? {}
      : {
          batch: {
            familyOf: () => "",
            maxIds: o.maxIds ?? 3,
            exactId: (id: string) => id === id.toLowerCase(),
          },
        }),
  });
  return calls;
}

function ackOf(h: Harness, ids: string): unknown {
  return h.frames.find(
    (f) => f.key === "rows" && f.kind === "sub-ack" && f.params?.ids === ids,
  )?.value;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await tick();
}

describe("point batch: reads queued together load as one", () => {
  test("queued tuples share one slot and one load, each served its own rows", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    const calls = defineRows(h);
    await gate.fill();

    for (const ids of ["a", "b", "a,c", "missing"])
      await h.subscribe("rows", { ids });
    // `a`, `b`, `a,c` fit one batch (a, b, c — `maxIds` 3); `missing` opens
    // the next: two reads queued, not four.
    expect(h.runtime.readGateStats().queued).toBe(2);

    gate.ctl.release();
    await settle();
    expect(calls).toEqual([
      { params: "a", ids: ["a", "b", "c"] },
      // A lone member loads exactly as an unbatched read.
      { params: "missing", ids: null },
    ]);
    expect(ackOf(h, "a")).toEqual([{ id: "a" }]);
    expect(ackOf(h, "b")).toEqual([{ id: "b" }]);
    expect(ackOf(h, "a,c")).toEqual([{ id: "a" }, { id: "c" }]);
    expect(ackOf(h, "missing")).toEqual([]);
    expect(h.runtime.readGateStats()).toMatchObject({ active: 0, queued: 0 });
  });

  test("an id under its own spelling that named no row is absent: answered from the batch, no re-read", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    const calls = defineRows(h);
    await gate.fill();

    await h.subscribe("rows", { ids: "a" });
    await h.subscribe("rows", { ids: "missing" });
    expect(h.runtime.readGateStats().queued).toBe(1);
    gate.ctl.release();
    await settle();
    // `missing` is the key's own spelling (`exactId`): the union's read
    // matched no row for it, so there is none — one load for both.
    expect(calls).toEqual([{ params: "a", ids: ["a", "missing"] }]);
    expect(ackOf(h, "a")).toEqual([{ id: "a" }]);
    expect(ackOf(h, "missing")).toEqual([]);
  });

  test("a member with an id under another spelling that named no row is read alone, in the same slot", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    const calls = defineRows(h);
    await gate.fill();

    await h.subscribe("rows", { ids: "b" });
    await h.subscribe("rows", { ids: "A" });
    await h.subscribe("rows", { ids: "MISSING" });
    expect(h.runtime.readGateStats().queued).toBe(1);
    gate.ctl.release();
    await settle();
    // `A` matches row `a`, served under `a`: in the union's rows it looks
    // like an absent id, which only the member's own read can tell apart —
    // as `MISSING`, which really is absent.
    expect(calls).toEqual([
      { params: "b", ids: ["b", "A", "MISSING"] },
      { params: "A", ids: null },
      { params: "MISSING", ids: null },
    ]);
    expect(ackOf(h, "b")).toEqual([{ id: "b" }]);
    expect(ackOf(h, "A")).toEqual([{ id: "a" }]);
    expect(ackOf(h, "MISSING")).toEqual([]);
  });

  test("a member whose subscriber left is dropped at the slot; the rest still load", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    const calls = defineRows(h);
    await gate.fill();

    await h.subscribe("rows", { ids: "a" });
    await h.subscribe("rows", { ids: "b" });
    await h.unsub("rows", { ids: "a" });

    gate.ctl.release();
    await settle();
    expect(calls).toEqual([{ params: "b", ids: null }]);
    expect(ackOf(h, "a")).toBeUndefined();
    expect(ackOf(h, "b")).toEqual([{ id: "b" }]);
  });

  test("a failed load fails every member", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    defineRows(h, { fail: true });
    await gate.fill();

    await h.subscribe("rows", { ids: "a" });
    await h.subscribe("rows", { ids: "b" });
    gate.ctl.release();
    await settle();
    const errors = h.frames.filter(
      (f) => f.key === "rows" && f.kind === "sub-error",
    );
    expect(errors.map((f) => f.params?.ids).sort()).toEqual(["a", "b"]);
  });

  test("with a free gate, reads arriving apart each load alone", async () => {
    const h = createHarness();
    const calls = defineRows(h);
    await h.subscribe("rows", { ids: "a" });
    await h.subscribe("rows", { ids: "b" });
    expect(calls).toEqual([
      { params: "a", ids: null },
      { params: "b", ids: null },
    ]);
  });

  test("an entry declaring no batch queues one read per tuple", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    defineRows(h, { batch: false });
    await gate.fill();

    for (const ids of ["a", "b", "c"]) await h.subscribe("rows", { ids });
    expect(h.runtime.readGateStats().queued).toBe(3);
    gate.ctl.release();
    await settle();
  });
});
