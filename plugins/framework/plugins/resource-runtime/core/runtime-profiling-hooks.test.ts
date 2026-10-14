/**
 * The runtime's profiling seams around the compute path: what `wrapLoad` is told
 * about a load (variant = canonical params, scopedIds on a scoped refill),
 * `wrapHttp` enclosing the whole `GET /api/resources/:key` request (its 304
 * included), `wrapMembership` enclosing a window's ids query, and `onDelivered`
 * carrying the delivered frame's size. The server binds each to a profiler span
 * (`server-core/core/resources.ts`); see
 * research/2026-09-23-global-live-state-plumbing-slow-op-coverage.md.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, tick } from "./test-support";
import { feedChange, identityPlan } from "./testing/routed-fixture";
import type { LoadInfo } from "./runtime";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;

// Keyed entries are routed over their identity table (the shared fixture's
// plan and change-feed delivery): scoped changes reach an entry only through
// its routes since P8 step 23a.

describe("wrapLoad info", () => {
  test("a param-less load carries no variant; a parameterized one carries its canonical params", async () => {
    const loads: Array<{ key: string; info: LoadInfo }> = [];
    const h = createHarness({
      wrapLoad: (key, info, fn) => {
        loads.push({ key, info });
        return fn();
      },
    });
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("r");
    await h.subscribe("r", { b: "2", a: "1" });

    expect(loads).toEqual([
      { key: "r", info: {} },
      // Sorted-key canonical form — the same `paramsKey` every per-pk map uses.
      { key: "r", info: { variant: '{"a":"1","b":"2"}' } },
    ]);
  });
});

describe("window membership", () => {
  function windowHarness() {
    const table = new Map<string, number>();
    const loads: LoadInfo[] = [];
    const membershipKeys: string[] = [];
    const h = createHarness({
      wrapLoad: (_key, info, fn) => {
        loads.push(info);
        return fn();
      },
      wrapMembership: (key, fn) => {
        membershipKeys.push(key);
        return fn();
      },
    });
    const members = () =>
      [...table.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([id, n]) => ({ id, n }));
    h.runtime.defineResource(
      {
        key: "win",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: identityPlan("row_table"),
        membership: {
          kind: "window",
          windowIdsOf: async () =>
            members()
              .slice(0, 3)
              .map((r) => r.id),
          limitOf: () => 3,
        },
        loader: (_p, c) =>
          c === undefined
            ? members().slice(0, 3)
            : c.affectedIds.map((id) => ({ id, n: table.get(id)! })),
      },
    );
    const insert = (id: string, n: number) => {
      table.set(id, n);
      feedChange(h, {
        table: "row_table",
        op: "I",
        ids: [id],
      });
    };
    return { h, table, loads, membershipKeys, insert };
  }

  test("an entrant's ids query runs inside wrapMembership, and its scoped refill reports scopedIds", async () => {
    const w = windowHarness();
    w.table.set("a", 1);
    await w.h.subscribe("win");
    w.loads.length = 0;

    w.insert("b", 2);
    await tick();

    expect(w.membershipKeys).toEqual(["win"]);
    expect(w.loads).toEqual([{ scopedIds: 1 }]);
  });
});

describe("wrapHttp", () => {
  test("encloses the whole request, a 304 included; an unknown key is never wrapped", async () => {
    const wrapped: string[] = [];
    const h = createHarness({
      wrapHttp: (key, fn) => {
        wrapped.push(key);
        return fn();
      },
    });
    let loads = 0;
    h.runtime.defineExternalResource({
      key: "r",
      mode: "invalidate",
      schema: z.number(),
      loader: async () => {
        loads++;
        return 5;
      },
      revalidate: async () => "sig-A",
    });

    const first = await h.runtime.handleResourceHttp(
      new Request("http://x/api/resources/r"),
      { key: "r" },
    );
    const token = first.headers.get("ETag")!;
    const notModified = await h.runtime.handleResourceHttp(
      new Request("http://x/api/resources/r", {
        headers: { "If-None-Match": token },
      }),
      { key: "r" },
    );
    const unknown = await h.runtime.handleResourceHttp(
      new Request("http://x/api/resources/nope"),
      { key: "nope" },
    );

    expect(notModified.status).toBe(304);
    expect(loads).toBe(1); // the 304 ran no loader — and was still wrapped
    expect(unknown.status).toBe(404);
    expect(wrapped).toEqual(["r", "r"]);
  });
});

describe("onDelivered frameChars", () => {
  test("reports the delivered frame's serialized length alongside the fan-out", async () => {
    const delivered: Array<{ subscribers: number; frameChars: number }> = [];
    const h = createHarness({
      sockets: 2,
      onDelivered: (_key, { subscribers, frameChars }) => {
        delivered.push({ subscribers, frameChars });
      },
    });
    let value = "x";
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => value,
    });
    await h.subscribe("r", {}, { socket: 0 });
    await h.subscribe("r", {}, { socket: 1 });

    value = "y".repeat(1000);
    r.notify();
    await tick();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.subscribers).toBe(2);
    // The frame carries the 1000-char value, so it is at least that long.
    expect(delivered[0]!.frameChars).toBeGreaterThan(1000);
  });
});
