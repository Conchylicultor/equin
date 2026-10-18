/**
 * Scoped-vs-FULL routing-table gaps. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-scoped-routing.test.ts`.
 *
 * The scoped-recompute routing table decides, per resource per flush, whether a
 * change recomputes only the affected rows (`ctx.affectedIds`, a `WHERE id IN (…)`
 * scoped load) or the whole view (`ctx === undefined`, FULL). This file pins the
 * COALESCING corners that `mergePending` (`runtime.ts:1087`) and `drainEntry`
 * (`runtime.ts:1544`) own within a single flush:
 *
 *   - sticky-FULL absorption (both orders): an id-less contributor in the same
 *     flush sticks the pk at FULL (`mergePending` null-absorption, `runtime.ts:1103`).
 *   - scoped∪scoped union: two scoped changes coalesce their id sets.
 *
 * The entry is a routed alias (its identity route), the shape every scoped
 * change reaches (P8 steps 23–24, 23a).
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, tick } from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));

// A keyed resource (a routed alias, the shared fixture) whose loader records how
// each post-subscribe load was scoped: "FULL" for `ctx === undefined`, else the
// sorted affected-id list. Two feed changes ride ONE flush because both are
// routed synchronously before the queued microtask flush drains — so they
// coalesce in `pendingNotifies`.
function scopeRecordingHarness() {
  const h = createHarness();
  const loads: string[] = [];
  const rows = defineRoutedTable(h, {
    key: "rows",
    table: "row_table",
    membership: "alias",
    schema: rowsSchema,
    orderOf: async () => ["a", "b"],
    loader: (_p, c) => {
      loads.push(
        c === undefined ? "FULL" : [...c.affectedIds].sort().join(","),
      );
      return [
        { id: "a", n: 1 },
        { id: "b", n: 1 },
      ];
    },
  });
  const scoped = (ids: string[]) => rows.feed("U", ids);
  const full = () => rows.feed("I", null);
  return { h, loads, scoped, full };
}

describe("scoped-vs-FULL routing — same-flush coalescing", () => {
  test("sticky-FULL absorption (scoped THEN full): an id-less contributor forces the pk to FULL", async () => {
    const { h, loads, scoped, full } = scopeRecordingHarness();
    await h.subscribe("rows");
    loads.length = 0; // ignore the sub-ack's full seed load

    // One flush, scoped-first: mergePending records {a}, then the FULL (null)
    // absorbs it → the loader recomputes FULL, never a scoped partial.
    scoped(["a"]);
    full();
    await tick();

    expect(loads).toEqual(["FULL"]);
  });

  test("sticky-FULL absorption (full THEN scoped): the pk stays FULL once id-less", async () => {
    const { h, loads, scoped, full } = scopeRecordingHarness();
    await h.subscribe("rows");
    loads.length = 0;

    // FULL-first: the pending entry is already FULL (null); the later scoped {a}
    // cannot narrow it (`existing.affected === null` returns early).
    full();
    scoped(["a"]);
    await tick();

    expect(loads).toEqual(["FULL"]);
  });

  test("scoped∪scoped union: two scoped changes coalesce their affected-id sets", async () => {
    const { h, loads, scoped } = scopeRecordingHarness();
    await h.subscribe("rows");
    loads.length = 0;

    // Two scoped changes to the same pk in one flush → the loader sees the UNION.
    scoped(["a"]);
    scoped(["b"]);
    await tick();

    expect(loads).toEqual(["a,b"]);
  });
});
