/**
 * D8 — a value recompute that changed nothing is not a change, whatever its
 * loader. A non-keyed drain of a pushed, non-persisted value compares its load
 * against the value every holder holds (`RegistryEntry.held`, by `diffValue`
 * — the comparison a patched value's frame is built from): equal ⇒ no version,
 * no frame (no empty `patch` either) — only the ack it owes; the cascade
 * still runs. The held value is set only when a frame reached every current
 * subscriber, in the tracking span its drain started in.
 * The churn monitor still hears of it (`onPush` with `changed: false`): the
 * loader ran for nothing.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintReachPlan } from "./routing";
import { createHarness, tick } from "./test-support";

const Schema = z.object({ s: z.string(), n: z.array(z.number()) });
type V = z.infer<typeof Schema>;

const reach = mintReachPlan({
  routes: [
    {
      id: "c",
      table: "conversations",
      map: { kind: "full", reason: "whole" },
      columns: ["id"],
    },
  ],
  usesOf: () => new Map([["c", { role: "membership" as const }]]),
});

function setup(
  opts: { patches?: true; sockets?: number; mutate?: boolean } = {},
) {
  const pushes: Array<{ key: string; changed: boolean; subscribers: number }> =
    [];
  const h = createHarness({
    sockets: opts.sockets ?? 1,
    onPush: (key, info) => pushes.push({ key, ...info }),
  });
  let truth: V = { s: "a", n: [1] };
  let loads = 0;
  let fail = false;
  let gate: Promise<void> = Promise.resolve();
  const shared: V = { s: "a", n: [1] };
  const r = h.runtime.defineExternalResource(
    {
      key: "r",
      schema: Schema,
      validateParams: () => {},
      ...(opts.patches ? { patches: true as const } : {}),
    },
    {
      mode: "push",
      reach,
      // A fresh object on every read — no memo, no `revalidate`. With
      // `mutate`, one object mutated in place and returned again.
      loader: async () => {
        loads++;
        await gate;
        if (fail) throw new Error("boom");
        if (opts.mutate) {
          shared.s = truth.s;
          shared.n = [...truth.n];
          return shared;
        }
        return { s: truth.s, n: [...truth.n] };
      },
    },
  );
  const write = (xid: string) =>
    h.runtime.routeTableChange({
      source: "feed",
      table: "conversations",
      op: "U",
      ids: ["x"],
      keys: null,
      unchanged: null,
      xid,
    });
  return {
    h,
    r,
    pushes,
    loads: () => loads,
    set: (v: V) => {
      truth = v;
    },
    write,
    failNext: (on: boolean) => {
      fail = on;
    },
    /** Park every load until the returned release is called. */
    park: () => {
      let release!: () => void;
      gate = new Promise((res) => (release = res));
      return () => {
        gate = Promise.resolve();
        release();
      };
    },
  };
}

const subAckVersion = (h: ReturnType<typeof createHarness>): number =>
  h.frames.find((f) => f.kind === "sub-ack")!.version!;

describe("D8 — an equal recompute of any pushed value sends nothing", () => {
  test("equal content in a new object: no frame, no version; the next change is version + 1", async () => {
    const t = setup();
    await t.h.subscribe("r");
    const v0 = subAckVersion(t.h);
    t.r.notify();
    await tick();
    t.r.notify();
    await tick();
    expect(t.loads()).toBe(3); // the recomputes ran …
    expect(t.h.pushesFor("r")).toEqual([]); // … and shipped nothing
    t.set({ s: "b", n: [1] });
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r").map((f) => [f.kind, f.version, f.value])).toEqual(
      [["update", v0 + 1, { s: "b", n: [1] }]],
    );
    // And the value that frame carried is then the held one.
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r")).toHaveLength(1);
  });

  test("a loader mutating its own return in place is still compared by content", async () => {
    const t = setup({ mutate: true });
    await t.h.subscribe("r");
    t.set({ s: "b", n: [2] });
    t.r.notify();
    await tick();
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r").map((f) => f.value)).toEqual([
      { s: "b", n: [2] },
    ]);
  });

  test("a skipped recompute still acks every write it was routed for", async () => {
    const t = setup();
    await t.h.subscribe("r", {}, { acks: true });
    t.write("tx-1");
    await tick();
    t.write("tx-2");
    await tick();
    expect(t.h.pushesFor("r").map((f) => [f.kind, f.ackTx])).toEqual([
      ["ack", ["tx-1"]],
      ["ack", ["tx-2"]],
    ]);
  });

  test("a second holder's sub-ack under equal content keeps the held value", async () => {
    const t = setup({ sockets: 2 });
    await t.h.subscribe("r", {}, { socket: 0 }); // sole: the held value
    await t.h.subscribe("r", {}, { socket: 1 }); // a fresh read, equal content
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r", 0)).toEqual([]);
    expect(t.h.pushesFor("r", 1)).toEqual([]);
  });

  test("a second holder's sub-ack under other content drops it: the next drain ships", async () => {
    const t = setup({ sockets: 2 });
    await t.h.subscribe("r", {}, { socket: 0 }); // holds a
    t.set({ s: "b", n: [1] });
    await t.h.subscribe("r", {}, { socket: 1 }); // holds b
    t.r.notify(); // b again: socket 0 lacks it
    await tick();
    expect(t.h.pushesFor("r", 0).map((f) => f.value)).toEqual([
      { s: "b", n: [1] },
    ]);
  });

  test("the churn monitor hears of the skip as a no-op push", async () => {
    const t = setup();
    await t.h.subscribe("r");
    t.r.notify();
    await tick();
    t.set({ s: "b", n: [1] });
    t.r.notify();
    await tick();
    expect(t.pushes).toEqual([
      { key: "r", changed: false, subscribers: 1 },
      { key: "r", changed: true, subscribers: 1 },
    ]);
  });
});

describe("D8 — patched values", () => {
  test("an equal recompute ships no empty patch; the next change patches from the same base", async () => {
    const t = setup({ patches: true });
    await t.h.subscribe("r");
    const v0 = subAckVersion(t.h);
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r")).toEqual([]);
    t.set({ s: "ab", n: [1, 2] });
    t.r.notify();
    await tick();
    expect(
      t.h.pushesFor("r").map((f) => [f.kind, f.base, f.version, f.ops]),
    ).toEqual([
      [
        "patch",
        v0,
        v0 + 1,
        [
          { at: ["s"], append: "b" },
          { at: ["n"], push: [2] },
        ],
      ],
    ]);
  });
});

describe("D8 — the held value is only ever what every holder holds", () => {
  // A drain with no held value (dropped here by a failed load) mints before
  // it loads and sends to the subscribers of that moment.
  async function dropHeld(t: ReturnType<typeof setup>): Promise<void> {
    t.failNext(true);
    t.r.notify();
    await tick();
    t.failNext(false);
  }

  test("a tab that subscribed while the drain loaded is no holder of its frame: nothing is held, the next equal drain ships", async () => {
    const t = setup({ sockets: 2 });
    await t.h.subscribe("r", {}, { socket: 0 });
    await dropHeld(t);
    t.set({ s: "b", n: [1] });
    const release = t.park();
    t.r.notify(); // mints, subs = [socket 0], parks in the load
    await tick();
    const late = t.h.subscribe("r", {}, { socket: 1 }); // not in that frame's set
    await tick();
    release();
    await late;
    await tick();
    const before = t.h.pushesFor("r", 1).length;
    t.r.notify(); // equal to the frame — but socket 1 may hold another read
    await tick();
    expect(
      t.h
        .pushesFor("r", 1)
        .slice(before)
        .map((f) => f.kind),
    ).toEqual(["update"]);
  });

  test("a drain outliving its span records nothing: the next subscriber of a patched value loads", async () => {
    const t = setup({ patches: true });
    await t.h.subscribe("r");
    await dropHeld(t);
    t.set({ s: "b", n: [1] });
    const release = t.park();
    t.r.notify(); // mints, subs = [socket 0], parks in the load
    await tick();
    await t.h.unsub("r"); // N→0 while the drain loads
    release();
    await tick();
    await tick();
    t.set({ s: "c", n: [1] });
    const loadsBefore = t.loads();
    await t.h.subscribe("r"); // 0→1: answered by a load, not a leftover base
    expect(t.loads()).toBe(loadsBefore + 1);
    expect(
      t.h.frames.filter((f) => f.kind === "sub-ack").at(-1)!.value,
    ).toEqual({ s: "c", n: [1] });
  });
});

describe("D8 — an equal recompute still cascades", () => {
  test("the downstream recomputes on it (its recompute is its own decision)", async () => {
    const h = createHarness();
    let downLoads = 0;
    const up = h.runtime.defineExternalResource(
      { key: "up", schema: z.number(), validateParams: () => {} },
      { mode: "push", loader: () => 1 },
    );
    h.runtime.defineResource({
      key: "down",
      mode: "push",
      schema: z.number(),
      loader: () => ++downLoads,
      dependsOn: [{ resource: up }],
    });
    await h.subscribe("up");
    await h.subscribe("down");
    const afterSub = downLoads;
    up.notify();
    await tick();
    await tick();
    up.notify();
    await tick();
    await tick();
    expect(h.pushesFor("up")).toEqual([]);
    expect(downLoads).toBe(afterSub + 2);
  });
});
