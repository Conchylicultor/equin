/**
 * A joining subscriber's read must not move the shared diff base AHEAD of the
 * value earlier holders were acked at the same version.
 *
 * The production trace (main, 2026-10-24, `queue-ranks:rows`): tab A subscribed
 * the sidebar's new id set and was acked at version 1 BEFORE `queue.seed-rank`
 * committed the new conversation's rank row; tab B subscribed the same tuple
 * AFTER the commit but BEFORE its NOTIFY arrived, and its sub-ack read re-seeded
 * the tuple's snapshot at the same version with the row in it (the old
 * `serveSub` re-seeded whenever the version had not moved since its read began). The NOTIFY then drained to an empty diff → a
 * standalone ack, no delta — and tab A sat on the rank-less value for good,
 * showing the conversation as Unranked.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, tick, makeClientView } from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";

const rowSchema = z.object({ id: z.string(), n: z.number() });
type Row = z.infer<typeof rowSchema>;
const keyOf = (r: unknown) => (r as { id: string }).id;

describe("a joiner's read committed ahead of its notify", () => {
  test("point: the earlier holder still receives the row the joiner already read", async () => {
    const h = createHarness({ sockets: 2 });
    let table: Row[] = [{ id: "a", n: 1 }];
    const rows = defineRoutedTable<Row>(h, {
      key: "rows",
      table: "row_table",
      membership: "point",
      schema: z.array(rowSchema),
      loader: (p, c) => {
        const ids = c ? c.affectedIds : (p.ids ?? "").split(",");
        return table.filter((r) => ids.includes(r.id));
      },
    });
    const params = { ids: "a,b" };

    // A subscribes: acked [a] — b has no row yet.
    await h.subscribe("rows", params, { socket: 0 });
    await tick();

    // b's row commits; its NOTIFY has not been delivered yet.
    table = [...table, { id: "b", n: 1 }];

    // B subscribes the same tuple in that gap: its read sees b.
    await h.subscribe("rows", params, { socket: 1 });
    await tick();

    // The NOTIFY lands.
    rows.feed("I", ["b"]);
    await tick();
    await tick();

    const a = makeClientView(keyOf);
    a.applyAll(h.framesFor(0));
    const b = makeClientView(keyOf);
    b.applyAll(h.framesFor(1));
    expect(b.value).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 1 },
    ]);
    expect(a.value).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 1 },
    ]);
  });
});
