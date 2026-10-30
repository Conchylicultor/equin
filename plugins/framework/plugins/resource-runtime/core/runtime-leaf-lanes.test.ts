/**
 * A leaf's drain (an entry with no downstream) runs as a lane off the flush
 * loop's critical path: a slow leaf loader no longer holds every later change.
 * Run with `./equin test plugins/framework/plugins/resource-runtime`.
 *
 * The 2026-10-29/30 incident: `conversations.context-usage` (a round trip to a
 * busy agent process, 2–10 s) held each flush pass, and every delivery that
 * landed meanwhile went out when it finished.
 * `research/2026-10-30-framework-live-flush-leaf-drain-lanes.md`.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, controllable, tick } from "./test-support";

describe("leaf drain lanes", () => {
  test("a slow leaf's own notifies landing mid-lane drain once, after it settles, with the latest value", async () => {
    const h = createHarness();
    const slow = controllable(0);
    let loads = 0;
    const slowR = h.runtime.defineExternalResource({
      key: "s",
      mode: "push",
      schema: z.number(),
      loader: async () => {
        loads++;
        return slow.loader();
      },
    });
    await h.subscribe("s");
    loads = 0;

    slow.block();
    slow.setValue(1);
    slowR.notify();
    await tick();
    // One drain per entry at a time: these wait for the lane, not a second load.
    slowR.notify();
    slowR.notify();
    await tick();
    expect(loads).toBe(1);

    slow.setValue(2);
    slow.release();
    await tick();
    await tick();
    expect(loads).toBe(2);
    expect(h.pushesFor("s").at(-1)?.value).toBe(2);
  });

  test("an upstream still settles before its downstream drains, while a slow leaf loads", async () => {
    let n = 0;
    const h = createHarness();
    const slow = controllable(0);
    const slowR = h.runtime.defineExternalResource({
      key: "s",
      mode: "push",
      schema: z.number(),
      loader: slow.loader,
    });
    const up = h.runtime.defineExternalResource({
      key: "up",
      mode: "push",
      schema: z.number(),
      loader: async () => ++n,
    });
    h.runtime.defineResource({
      key: "down",
      mode: "push",
      schema: z.number(),
      loader: async () => ++n,
      dependsOn: [{ resource: up }],
    });
    await h.subscribe("s");
    await h.subscribe("up");
    await h.subscribe("down");

    slow.block();
    slow.setValue(1);
    slowR.notify();
    await tick();
    up.notify();
    await tick();

    const ups = h.pushesFor("up");
    const downs = h.pushesFor("down");
    expect(ups).toHaveLength(1);
    expect(downs).toHaveLength(1);
    expect(ups[0]!.seq).toBeLessThan(downs[0]!.seq);
    expect(h.pushesFor("s")).toHaveLength(0);

    slow.release();
    await tick();
    expect(h.pushesFor("s")).toHaveLength(1);
  });

  test("the pass's flush wrapper stays open until its lanes settle, and the next pass opens meanwhile", async () => {
    const open = new Set<number>();
    let passes = 0;
    let maxOpen = 0;
    const h = createHarness({
      wrapFlush: async (fn) => {
        const id = passes++;
        open.add(id);
        maxOpen = Math.max(maxOpen, open.size);
        try {
          await fn();
        } finally {
          open.delete(id);
        }
      },
    });
    const slow = controllable(0);
    const slowR = h.runtime.defineExternalResource({
      key: "s",
      mode: "push",
      schema: z.number(),
      loader: slow.loader,
    });
    let n = 0;
    const fastR = h.runtime.defineExternalResource({
      key: "f",
      mode: "push",
      schema: z.number(),
      loader: async () => ++n,
    });
    await h.subscribe("s");
    await h.subscribe("f");

    slow.block();
    slow.setValue(1);
    slowR.notify();
    await tick();
    expect(open.size).toBe(1); // the slow lane's pass

    fastR.notify();
    await tick();
    expect(h.pushesFor("f")).toHaveLength(1);
    expect(maxOpen).toBe(2); // the fast pass ran while the slow one was open
    expect(open.size).toBe(1);

    slow.release();
    await tick();
    expect(open.size).toBe(0);
    expect(h.pushesFor("s")).toHaveLength(1);
  });

  test("a throttled leaf whose window opens while its lane is in flight drains once the lane settles", async () => {
    const h = createHarness();
    const slow = controllable(0);
    const r = h.runtime.defineExternalResource({
      key: "t",
      mode: "push",
      schema: z.number(),
      debounceMs: 10,
      loader: slow.loader,
    });
    await h.subscribe("t");

    slow.block();
    slow.setValue(1);
    r.notify();
    await tick();
    r.notify(); // inside the window: a timer releases it while the lane loads
    await new Promise((res) => setTimeout(res, 30));
    expect(h.pushesFor("t")).toHaveLength(0);

    slow.setValue(2);
    slow.release();
    await tick();
    await tick();
    expect(h.pushesFor("t").at(-1)?.value).toBe(2);
  });
});
