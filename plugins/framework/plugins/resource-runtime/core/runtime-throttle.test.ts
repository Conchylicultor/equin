/**
 * A debounced entry (`debounceMs`, which a served value's `throttleMs` compiles
 * to) recomputes at most once per window, whatever else flushes. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-throttle.test.ts`.
 *
 * Before: any flush another resource scheduled drained the throttled entry's
 * pending too (piggyback), so on a busy server a 30 s throttle rebuilt ~18×/min;
 * and a cascade into a throttled downstream drained it in the same flush, never
 * arming its window. See research/2026-10-22-global-live-throttle-holds.md.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, tick } from "./test-support";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("debounceMs holds", () => {
  test("other resources flushing inside the window do not drain a throttled entry", async () => {
    const h = createHarness();
    let loads = 0;
    const slow = h.runtime.defineExternalResource({
      key: "throttled",
      mode: "push",
      schema: z.number(),
      debounceMs: 60,
      loader: () => ++loads,
    });
    const busy = h.runtime.defineExternalResource({
      key: "busy",
      mode: "push",
      schema: z.number(),
      loader: () => Date.now(),
    });
    await h.subscribe("throttled");
    await h.subscribe("busy");
    const afterSub = loads;

    // A busy server: an unrelated resource flushes on every tick, each beside
    // a change to the throttled one.
    for (let i = 0; i < 10; i++) {
      slow.notify();
      busy.notify();
      await tick();
    }
    expect(loads).toBe(afterSub); // held — the window has not elapsed

    await sleep(100);
    expect(loads).toBe(afterSub + 1); // one recompute for the whole burst
    expect(h.pushesFor("throttled")).toHaveLength(1);

    // The window is fixed and re-opens on the next change.
    slow.notify();
    busy.notify();
    await tick();
    expect(loads).toBe(afterSub + 1);
    await sleep(100);
    expect(loads).toBe(afterSub + 2);
  });

  test("a cascade into a throttled downstream waits for its window", async () => {
    const h = createHarness();
    const up = h.runtime.defineExternalResource({
      key: "up",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    let downLoads = 0;
    h.runtime.defineResource({
      key: "down",
      mode: "push",
      schema: z.number(),
      debounceMs: 60,
      loader: () => ++downLoads,
      dependsOn: [{ resource: up }],
    });
    await h.subscribe("up");
    await h.subscribe("down");
    const afterSub = downLoads;

    for (let i = 0; i < 5; i++) {
      up.notify();
      await tick();
    }
    expect(h.pushesFor("up").length).toBeGreaterThan(0);
    expect(downLoads).toBe(afterSub); // the cascade armed the window, not a drain

    await sleep(100);
    expect(downLoads).toBe(afterSub + 1);
  });

  test("a change landing while a window is due rides that drain", async () => {
    const h = createHarness();
    let loads = 0;
    const r = h.runtime.defineExternalResource({
      key: "t",
      mode: "push",
      schema: z.number(),
      debounceMs: 20,
      loader: () => ++loads,
    });
    const other = h.runtime.defineExternalResource({
      key: "o",
      mode: "push",
      schema: z.number(),
      loader: () => 0,
    });
    await h.subscribe("t");
    await h.subscribe("o");
    const afterSub = loads;

    r.notify();
    await sleep(40);
    expect(loads).toBe(afterSub + 1);
    // Batched notifies arm the window at the batch's exit.
    await h.runtime.withNotifyBatch(async () => {
      r.notify();
      other.notify();
    });
    await tick();
    expect(loads).toBe(afterSub + 1);
    await sleep(40);
    expect(loads).toBe(afterSub + 2);
  });
});
