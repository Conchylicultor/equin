/**
 * `onPush` carries what the recompute cost (`RecomputeCost`): the sum of the
 * `push` origins its drain ran, as the host's `wrapOrigin` measured them
 * (`onCost`) — own work = wall − waits, the io part of the waits, every wait.
 * The live-state no-op detector judges a churning resource on it. A host whose
 * `wrapOrigin` hands no cost reads `null`, never a made-up zero.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintReachPlan } from "@plugins/network/plugins/live/plugins/resource-runtime/plugins/routing/core";
import type { OriginCost, RecomputeCost } from "./runtime";
import { createHarness, tick } from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";

// Every origin "costs" this: 10 ms wall, of which 4 ms waited (1 ms of it io).
const ORIGIN: OriginCost = { wallMs: 10, waitMs: 4, ioMs: 1 };

interface Push {
  changed: boolean;
  cost: RecomputeCost | null;
}

function harness(withCost: boolean) {
  const pushes: Push[] = [];
  const h = createHarness({
    onPush: (_key, info) =>
      pushes.push({ changed: info.changed, cost: info.cost }),
    wrapOrigin: (_kind, _key, fn, _onJoined, onCost) =>
      fn().finally(() => {
        if (withCost) onCost?.(ORIGIN);
      }),
  });
  return { h, pushes };
}

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));

function keyed(withCost: boolean) {
  const { h, pushes } = harness(withCost);
  let table = [
    { id: "a", n: 1 },
    { id: "b", n: 1 },
  ];
  const rows = defineRoutedTable(h, {
    key: "rows",
    table: "row_table",
    membership: "alias",
    schema: rowsSchema,
    orderOf: async () => table.map((r) => r.id),
    loader: (_p, c) =>
      c === undefined
        ? table
        : table.filter((r) => c.affectedIds.includes(r.id)),
  });
  return {
    h,
    pushes,
    rows,
    insert: (row: { id: string; n: number }) => {
      table = [...table, row];
    },
  };
}

describe("onPush carries the recompute's cost", () => {
  test("a scoped refill that changed nothing: one origin's cost, as own / wait / io", async () => {
    const t = keyed(true);
    await t.h.subscribe("rows");
    t.rows.feed("U", ["a"]);
    await tick();
    expect(t.pushes).toEqual([
      { changed: false, cost: { ownMs: 6, waitMs: 4, ioMs: 1 } },
    ]);
  });

  test("an entrant: the refill and the order query are one recompute, their costs summed", async () => {
    const t = keyed(true);
    await t.h.subscribe("rows");
    t.insert({ id: "c", n: 1 });
    t.rows.feed("I", ["c"]);
    await tick();
    expect(t.pushes).toEqual([
      { changed: true, cost: { ownMs: 12, waitMs: 8, ioMs: 2 } },
    ]);
  });

  test("a FULL recompute of a keyed tuple that changed nothing", async () => {
    const t = keyed(true);
    await t.h.subscribe("rows");
    t.rows.feed("U", null);
    await tick();
    expect(t.pushes).toEqual([
      { changed: false, cost: { ownMs: 6, waitMs: 4, ioMs: 1 } },
    ]);
  });

  test("a pushed value recompute equal to what its holders hold (D8)", async () => {
    const { h, pushes } = harness(true);
    const r = h.runtime.defineExternalResource(
      {
        key: "v",
        schema: z.object({ s: z.string() }),
        validateParams: () => {},
      },
      {
        mode: "push",
        reach: mintReachPlan({
          routes: [
            {
              id: "c",
              table: "t",
              map: { kind: "full", reason: "whole" },
              columns: ["id"],
            },
          ],
          usesOf: () => new Map([["c", { role: "membership" as const }]]),
        }),
        loader: async () => ({ s: "same" }),
      },
    );
    await h.subscribe("v");
    r.notify();
    await tick();
    expect(pushes).toEqual([
      { changed: false, cost: { ownMs: 6, waitMs: 4, ioMs: 1 } },
    ]);
  });

  test("a host that measures nothing: the cost is null, not zero", async () => {
    const t = keyed(false);
    await t.h.subscribe("rows");
    t.rows.feed("U", ["a"]);
    await tick();
    expect(t.pushes).toEqual([{ changed: false, cost: null }]);
  });
});
