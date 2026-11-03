/**
 * The EXTERNAL keyed point arm (`ExternalPointMembership`): a keyed external
 * resource whose tuple names an id set (`idsOf`). Never routed (D31) — its
 * change is its own `notify(params)`, a FULL re-read of the tuple diffed by
 * key against its snapshot, so it ships keyed `delta` frames exactly as the
 * external window does.
 *
 * Also pins the late-registration path a host with open sockets relies on: a
 * `defineExternalResource` AFTER sockets opened (and after a refused sub to the
 * same key) serves the next sub of that key.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ResourceParams } from "./runtime";
import { createHarness, tick } from "./test-support";

interface Row {
  id: string;
  n: number;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await tick();
};

const KEY = "ext.rows";

function pointHarness() {
  const table = new Map<string, number>([
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  const idsOf = (p: ResourceParams): string[] =>
    p.ids === undefined || p.ids === "" ? [] : p.ids.split(",");
  const loads: string[] = [];
  const h = createHarness();
  const resource = h.runtime.defineExternalResource(
    {
      key: KEY,
      schema: z.array(z.object({ id: z.string(), n: z.number() })),
      keyed: { keyOf: (r: unknown) => (r as Row).id },
      validateParams: () => {},
    },
    {
      membership: { kind: "point", idsOf },
      loader: (p) => {
        loads.push(p.ids ?? "");
        return idsOf(p)
          .filter((id) => table.has(id))
          .map((id) => ({ id, n: table.get(id)! }));
      },
    },
  );
  return { h, table, loads, resource };
}

describe("an external keyed point set", () => {
  test("registers keyed and serves its tuple's ids on subscribe", async () => {
    const { h, resource } = pointHarness();
    expect(resource.mode).toBe("keyed");
    await h.subscribe(KEY, { ids: "a,b" });
    const ack = h.frames.find((f) => f.kind === "sub-ack" && f.key === KEY);
    expect(ack?.value).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
  });

  test("notify re-reads the tuple whole and ships a keyed delta", async () => {
    const { h, table, loads, resource } = pointHarness();
    await h.subscribe(KEY, { ids: "a,b" });
    await h.subscribe(KEY, { ids: "c" });

    // An in-place change to a member: one upsert, no order, no delete.
    table.set("a", 10);
    const loadsAt = loads.length;
    resource.notify({ ids: "a,b" });
    await settle();
    let pushes = h.pushesFor(KEY);
    expect(pushes.map((f) => f.kind)).toEqual(["delta"]);
    expect(pushes[0]!.params).toEqual({ ids: "a,b" });
    expect(pushes[0]!.upserts).toEqual([["a", { id: "a", n: 10 }]]);
    expect(pushes[0]!.deletes ?? []).toEqual([]);
    expect(pushes[0]!.order).toBeUndefined();
    // Only the notified tuple re-read — the other tuple was not told.
    expect(loads.slice(loadsAt)).toEqual(["a,b"]);

    // A member gone from the source: a delete, the order re-asserted.
    table.delete("b");
    resource.notify({ ids: "a,b" });
    await settle();
    pushes = h.pushesFor(KEY);
    const last = pushes.at(-1)!;
    expect(last.kind).toBe("delta");
    expect(last.deletes).toEqual(["b"]);
    expect(last.upserts ?? []).toEqual([]);
    expect(last.order).toEqual(["a"]);

    // A change outside the set changes nothing in this tuple: the FULL drain
    // (as the external window's) still ships its version as an EMPTY delta.
    const count = h.pushesFor(KEY).length;
    table.set("z", 99);
    resource.notify({ ids: "a,b" });
    await settle();
    pushes = h.pushesFor(KEY);
    expect(pushes.length).toBe(count + 1);
    const empty = pushes.at(-1)!;
    expect(empty.kind).toBe("delta");
    expect(empty.upserts).toEqual([]);
    expect(empty.deletes).toEqual([]);
    expect(empty.order).toBeUndefined();
  });

  test("an alias stays refused", () => {
    const { h } = pointHarness();
    const contract = {
      key: "ext.other",
      schema: z.array(z.object({ id: z.string() })),
      keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
      validateParams: () => {},
    };
    expect(() =>
      h.runtime.defineExternalResource(contract, {
        scopedMembership: { orderOf: async () => [] },
        loader: () => [],
      } as never),
    ).toThrow(/an external keyed entry is a bounded window .* or a point set/);
  });
});

describe("late registration on a runtime with open sockets", () => {
  test("a defineExternalResource after sockets opened serves the next sub of its key", async () => {
    const h = createHarness({ sockets: 2 });
    // Something already live on the socket before the late definition.
    h.runtime.defineExternalResource({
      key: "early",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    await h.subscribe("early");

    // A sub that arrives before the key exists is refused …
    await h.subscribe("late", {}, { socket: 1 });
    const refused = h.framesFor(1).find((f) => f.key === "late");
    expect(refused?.kind).toBe("sub-error");

    // … and once the key is defined, the next sub (any socket) is served.
    let n = 7;
    const late = h.runtime.defineExternalResource({
      key: "late",
      mode: "push",
      schema: z.number(),
      loader: () => n,
    });
    await h.subscribe("late", {}, { socket: 1 });
    const ack = h
      .framesFor(1)
      .filter((f) => f.key === "late")
      .at(-1)!;
    expect(ack.kind).toBe("sub-ack");
    expect(ack.value).toBe(7);

    // And it is live: a notify pushes to the late subscriber.
    n = 8;
    late.notify({});
    await settle();
    const pushed = h
      .framesFor(1)
      .filter(
        (f) =>
          f.key === "late" && f.kind !== "sub-ack" && f.kind !== "sub-error",
      );
    expect(pushed.at(-1)?.value).toBe(8);
  });
});
