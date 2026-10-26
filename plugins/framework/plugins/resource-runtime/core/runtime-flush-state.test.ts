/**
 * The flush scheduler can never strand a request. Run with
 * `./equin test plugins/framework/plugins/resource-runtime`.
 *
 * The 2026-10-26 incident: main pushed nothing for 7 minutes while subscribe
 * replies kept working, no span stayed open and `flushOpenMs` read 0. The old
 * scheduler checked its rerun flag at the end of the last pass but released the
 * mutex several microtask hops later (after the async flush wrapper unwound). A
 * notify landing in that gap set `flushScheduled`, its queued flush found the
 * mutex still held and only set the rerun flag — then the mutex was released
 * with nobody left to read it, `flushScheduled` stayed true forever, and every
 * later notify returned at `scheduleFlush`'s first line.
 * `research/2026-10-26-framework-live-push-wedge-stranded-flush.md`.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, controllable, tick } from "./test-support";

/** Yield `n` microtasks — the hops an async flush wrapper takes to unwind. */
async function hops(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("flush scheduler — no stranded request", () => {
  test("a notify landing while the flush wrapper unwinds is delivered, and later notifies still flush", async () => {
    let onUnwind: (() => void) | undefined;
    const h = createHarness({
      wrapFlush: async (fn) => {
        await fn();
        // The pass is over; the wrapper is still unwinding (a span's finally).
        const hook = onUnwind;
        onUnwind = undefined;
        hook?.();
        await hops(3);
      },
    });
    const a = controllable(0);
    const b = controllable(0);
    const aR = h.runtime.defineExternalResource({
      key: "a",
      mode: "push",
      schema: z.number(),
      loader: a.loader,
    });
    const bR = h.runtime.defineExternalResource({
      key: "b",
      mode: "push",
      schema: z.number(),
      loader: b.loader,
    });
    await h.subscribe("a");
    await h.subscribe("b");

    a.setValue(1);
    b.setValue(1);
    onUnwind = () => bR.notify();
    aR.notify();
    await tick();
    expect(h.pushesFor("a")).toHaveLength(1);
    expect(h.pushesFor("b")).toHaveLength(1);

    // The scheduler is not wedged: an ordinary notify afterwards still flushes.
    a.setValue(2);
    aR.notify();
    await tick();
    expect(h.pushesFor("a")).toHaveLength(2);
  });

  test("notifies interleaved with 0–5 microtask hops around pass boundaries all deliver", async () => {
    // A fixed-seed LCG so a failure replays identically.
    let seed = 0x2026_1026;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed % n;
    };
    const h = createHarness({
      wrapFlush: async (fn) => {
        await hops(rand(3));
        await fn();
        await hops(rand(4));
      },
    });
    const values = [0, 0, 0];
    const resources = values.map((_, i) =>
      h.runtime.defineExternalResource({
        key: `r${i}`,
        mode: "push",
        schema: z.number(),
        loader: async () => {
          await hops(rand(3));
          return values[i]!;
        },
      }),
    );
    for (let i = 0; i < resources.length; i++) await h.subscribe(`r${i}`);

    for (let round = 0; round < 200; round++) {
      const i = rand(resources.length);
      values[i]! += 1;
      resources[i]!.notify();
      await hops(rand(6));
    }
    await tick();
    // Every resource's last frame carries its final value: nothing stranded.
    for (let i = 0; i < resources.length; i++) {
      const pushes = h.pushesFor(`r${i}`);
      expect(pushes.at(-1)?.value).toBe(values[i]);
    }
  });

  test("a pass that throws while a rerun is requested still runs the rerun", async () => {
    let throwOnce = false;
    let onThrow: (() => void) | undefined;
    const reported: string[] = [];
    const h = createHarness({
      reportError: (context) => reported.push(context),
      wrapFlush: async (fn) => {
        await fn();
        if (throwOnce) {
          throwOnce = false;
          onThrow?.();
          throw new Error("wrapper failed");
        }
      },
    });
    const a = controllable(0);
    const b = controllable(0);
    const aR = h.runtime.defineExternalResource({
      key: "a",
      mode: "push",
      schema: z.number(),
      loader: a.loader,
    });
    const bR = h.runtime.defineExternalResource({
      key: "b",
      mode: "push",
      schema: z.number(),
      loader: b.loader,
    });
    await h.subscribe("a");
    await h.subscribe("b");

    a.setValue(1);
    b.setValue(1);
    throwOnce = true;
    onThrow = () => bR.notify();
    aR.notify();
    await tick();
    await tick();
    // The failure stays loud …
    expect(reported).toEqual(["flush pass failed"]);
    // … and the notify requested during the failing pass is not lost.
    expect(h.pushesFor("b")).toHaveLength(1);
  });
});
