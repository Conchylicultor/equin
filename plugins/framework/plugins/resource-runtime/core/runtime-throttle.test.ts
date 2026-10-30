/**
 * A throttled entry (`debounceMs`, which a served value's `throttleMs` compiles
 * to) recomputes at most once per window, whatever else flushes — and an
 * isolated change (none drained within the last window) drains at once: the
 * throttle is leading-edge, so it bounds the rate without delaying every change
 * by a window. Run with `./equin test plugins/framework/plugins/resource-runtime`.
 *
 * Before: any flush another resource scheduled drained the throttled entry's
 * pending too (piggyback), so on a busy server a 30 s throttle rebuilt ~18×/min;
 * and a cascade into a throttled downstream drained it in the same flush, never
 * arming its window. See research/2026-10-22-global-live-throttle-holds.md.
 * Then: the window was trailing-only, so every change — an isolated one too —
 * waited the whole window (`app-usage.summary` delivered each once-a-minute
 * flush 2 s late, a slow `deliver:` span every time).
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

    // An isolated change drains at once (the leading edge).
    slow.notify();
    await tick();
    expect(loads).toBe(afterSub + 1);

    // A busy server: an unrelated resource flushes on every tick, each beside
    // a change to the throttled one — all inside the window the drain opened.
    for (let i = 0; i < 10; i++) {
      slow.notify();
      busy.notify();
      await tick();
    }
    expect(loads).toBe(afterSub + 1); // held — the window has not elapsed

    await sleep(100);
    expect(loads).toBe(afterSub + 2); // one trailing recompute for the burst
    expect(h.pushesFor("throttled")).toHaveLength(2);

    // That drain opened a fresh window: a change inside it waits it out.
    slow.notify();
    busy.notify();
    await tick();
    expect(loads).toBe(afterSub + 2);
    await sleep(100);
    expect(loads).toBe(afterSub + 3);

    // Quiet for longer than the window: the next change drains at once again.
    await sleep(100);
    slow.notify();
    await tick();
    expect(loads).toBe(afterSub + 4);
  });

  test("a cascade into a throttled downstream waits for its window", async () => {
    const h = createHarness();
    let upLoads = 0;
    const up = h.runtime.defineExternalResource({
      key: "up",
      mode: "push",
      schema: z.number(),
      loader: () => ++upLoads, // a change on every recompute
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

    up.notify();
    await tick();
    expect(downLoads).toBe(afterSub + 1); // the first cascade: the leading edge

    for (let i = 0; i < 5; i++) {
      up.notify();
      await tick();
    }
    expect(h.pushesFor("up").length).toBeGreaterThan(1);
    expect(downLoads).toBe(afterSub + 1); // inside the window: held

    await sleep(100);
    expect(downLoads).toBe(afterSub + 2);
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
    await tick();
    expect(loads).toBe(afterSub + 1); // leading edge
    // Batched notifies inside the window arm its remainder at the batch's exit.
    await h.runtime.withNotifyBatch(async () => {
      r.notify();
      other.notify();
    });
    await tick();
    expect(loads).toBe(afterSub + 1);
    await sleep(40);
    expect(loads).toBe(afterSub + 2);
  });

  test("a held change's frame says how long the throttle held it (timing.holdMs)", async () => {
    const h = createHarness();
    const r = h.runtime.defineExternalResource({
      key: "held",
      mode: "push",
      schema: z.number(),
      debounceMs: 60,
      loader: () => Date.now(),
    });
    await h.subscribe("held");

    r.notify(); // the leading edge: drains at once, held for nothing
    await tick();
    r.notify(); // inside the window the first drain opened: waits it out
    await tick();
    await sleep(100);

    const timings = h.pushesFor("held").map((f) => f.timing);
    expect(timings).toHaveLength(2);
    expect(timings[0]!.holdMs).toBeLessThan(5);
    // Held for the rest of the 60 ms window — and the hold sits inside deliverMs.
    expect(timings[1]!.holdMs).toBeGreaterThan(30);
    expect(timings[1]!.deliverMs).toBeGreaterThanOrEqual(timings[1]!.holdMs);
  });

  test("an entry with no throttle is never held", async () => {
    const h = createHarness();
    const r = h.runtime.defineExternalResource({
      key: "free",
      mode: "push",
      schema: z.number(),
      loader: () => Date.now(),
    });
    await h.subscribe("free");
    r.notify();
    await tick();
    expect(h.pushesFor("free")[0]!.timing!.holdMs).toBe(0);
  });
});
