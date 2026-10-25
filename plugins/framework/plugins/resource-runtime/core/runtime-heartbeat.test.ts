/**
 * The heartbeat ping carries `flushOpenMs` — how long the running flush pass has
 * been open (0 when idle). Run with
 * `./equin test plugins/framework/plugins/resource-runtime`.
 *
 * The 2026-09-11 incident: a DB socket was closed under a query inside a flush,
 * the query's promise never settled, and — flushes being single-active — every
 * later push queued behind it for 25 minutes. The pings kept flowing, so the tab
 * saw a healthy, quiet socket. The ping is the one frame that still reaches the
 * tab while pushes are stuck, so it reports the stall; the Connection row of the
 * health report turns it into "live updates have been stuck for N min".
 * `research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`.
 *
 * The heartbeat interval and the clock are both captured, not waited on: the
 * interval's callback is taken off a `setInterval` spy when a probe socket opens,
 * and `performance.now()` is a hand-advanced fake.
 */

import { test, expect, describe, spyOn } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  controllable,
  tick,
  type Harness,
} from "./test-support";

/**
 * Open one extra socket on the harness's runtime whose heartbeat the test fires
 * by hand. `beat()` runs the interval callback and returns the ping it sent.
 */
function openProbe(h: Harness): { beat: () => Record<string, unknown> } {
  const sent: Record<string, unknown>[] = [];
  const ws = {
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
  };
  let heartbeat: (() => void) | undefined;
  const spy = spyOn(globalThis, "setInterval").mockImplementation(((
    fn: () => void,
  ) => {
    heartbeat = fn;
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  try {
    (h.runtime.notificationsWsHandler as any).open(ws);
  } finally {
    spy.mockRestore();
  }
  const fire = heartbeat;
  if (!fire) throw new Error("the socket opened without a heartbeat interval");
  return {
    beat() {
      fire();
      const last = sent.at(-1);
      if (last?.kind !== "ping") throw new Error("the heartbeat sent no ping");
      return last;
    },
  };
}

/** A fake `performance.now()` the test advances by hand. */
function fakeClock(): { advance: (ms: number) => void; restore: () => void } {
  let now = 1_000;
  const spy = spyOn(performance, "now").mockImplementation(() => now);
  return {
    advance: (ms) => {
      now += ms;
    },
    restore: () => spy.mockRestore(),
  };
}

describe("heartbeat — flushOpenMs", () => {
  test("an idle runtime pings 0", async () => {
    const clock = fakeClock();
    try {
      const h = createHarness();
      const probe = openProbe(h);
      expect(probe.beat()).toEqual({ kind: "ping", flushOpenMs: 0 });
      clock.advance(60_000);
      expect(probe.beat()).toEqual({ kind: "ping", flushOpenMs: 0 });
    } finally {
      clock.restore();
    }
  });

  test("a flush whose loader never settles pings a growing age, then 0 once it settles", async () => {
    const clock = fakeClock();
    try {
      const h = createHarness();
      const stuck = controllable(0);
      const r = h.runtime.defineExternalResource({
        key: "stuck",
        mode: "push",
        schema: z.number(),
        loader: stuck.loader,
      });
      await h.subscribe("stuck");
      const probe = openProbe(h);

      stuck.block();
      stuck.setValue(1);
      r.notify();
      await tick(); // the flush is parked on the loader, holding the mutex

      clock.advance(5_000);
      expect(probe.beat().flushOpenMs).toBe(5_000);
      clock.advance(40_000);
      expect(probe.beat().flushOpenMs).toBe(45_000);
      expect(h.pushesFor("stuck")).toHaveLength(0); // nothing delivered meanwhile

      stuck.release();
      await tick();
      expect(h.pushesFor("stuck")).toHaveLength(1);
      expect(probe.beat().flushOpenMs).toBe(0);
    } finally {
      clock.restore();
    }
  });

  test("a re-drain pass restarts the age: a busy flush is not a stuck one", async () => {
    const clock = fakeClock();
    try {
      const h = createHarness();
      const slow = controllable(0);
      const r = h.runtime.defineExternalResource({
        key: "slow",
        mode: "push",
        schema: z.number(),
        loader: slow.loader,
      });
      await h.subscribe("slow");
      const probe = openProbe(h);

      // Pass 1 parks for 20 s; a notify landing mid-pass queues a re-drain under
      // the SAME mutex hold.
      slow.block();
      slow.setValue(1);
      r.notify();
      await tick();
      clock.advance(20_000);
      slow.setValue(2);
      r.notify();
      await tick();
      expect(probe.beat().flushOpenMs).toBe(20_000);

      // Release pass 1 and park pass 2 before it starts its load.
      slow.release();
      slow.block();
      await tick();
      expect(h.pushesFor("slow")).toHaveLength(1); // pass 1 delivered

      // Still one mutex hold, but its age is the current pass's, not the hold's.
      clock.advance(1_000);
      expect(probe.beat().flushOpenMs).toBe(1_000);

      // Pass 2 reads a value of its own (pass 1 resolved at release with 2 —
      // an equal recompute would ship nothing).
      slow.setValue(3);
      slow.release();
      await tick();
      expect(h.pushesFor("slow")).toHaveLength(2);
      expect(probe.beat().flushOpenMs).toBe(0);
    } finally {
      clock.restore();
    }
  });
});
