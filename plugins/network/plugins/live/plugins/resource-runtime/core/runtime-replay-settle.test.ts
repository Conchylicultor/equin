/**
 * The restart replay's settle (`replay-settle.ts`, the runtime's
 * `replaySettled`): what a serving host waits on before its post-serving
 * background work. Run under the fake clock — every bound is a timer window.
 *
 * Pins:
 *   - with no tab replaying, it settles `no-replay` at the herd window, not
 *     before; a fresh tab's subs (no foreign epoch) are not a replay;
 *   - a replay (subs echoing another boot's epoch) settles `replayed` only
 *     once every request is answered AND the quiet window passed since the
 *     last answer — a second socket's replay landing inside it extends it;
 *   - a request whose read hangs holds it until the ceiling (`ceiling`,
 *     naming what was owed); a closed socket, or an unsub, stops owing it;
 *   - a host that never arms (central, a browser host) stops tracking at the
 *     ceiling counted from its first replay request.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { REPLAY_SETTLE_BOUNDS, type ReplaySettled } from "./replay-settle";
import { controllable, createHarness } from "./test-support";
import { withFakeClock } from "./testing/fake-clock";

const OLD_EPOCH = "an-earlier-boot";
const { herdWaitMs, quietMs, ceilingMs } = REPLAY_SETTLE_BOUNDS;

function watch(p: Promise<ReplaySettled>): { outcome: ReplaySettled | null } {
  const box: { outcome: ReplaySettled | null } = { outcome: null };
  void p.then((o) => {
    box.outcome = o;
  });
  return box;
}

function define(h: ReturnType<typeof createHarness>, key: string): void {
  h.runtime.defineExternalResource({
    key,
    mode: "push",
    schema: z.string(),
    loader: async () => `${key}-val`,
  });
}

describe("replaySettled — when the restart replay has been answered", () => {
  test("no tab replays: settles no-replay at the herd window; a fresh tab is not a replay", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness();
      define(h, "a");
      const settled = watch(h.runtime.replaySettled());
      // A fresh tab: no epoch echoed.
      await h.subscribeBatch([{ key: "a" }], { tabId: "fresh" });
      await clock.advance(herdWaitMs - 1);
      expect(settled.outcome).toBeNull();
      await clock.advance(1);
      expect(settled.outcome?.kind).toBe("no-replay");
    });
  });

  test("a replay settles once answered and quiet; a later socket's replay inside the quiet window extends it", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness({ sockets: 2 });
      define(h, "a");
      define(h, "b");
      const settled = watch(h.runtime.replaySettled());
      await h.subscribeBatch([{ key: "a" }, { key: "b" }], {
        tabId: "t1",
        epoch: OLD_EPOCH,
      });
      expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(2);
      await clock.advance(quietMs - 100);
      expect(settled.outcome).toBeNull();
      // The second browser's socket reconnects a little later.
      await h.subscribeBatch([{ key: "a" }], {
        tabId: "t2",
        epoch: OLD_EPOCH,
        socket: 1,
      });
      await clock.advance(quietMs - 100);
      expect(settled.outcome).toBeNull();
      await clock.advance(100);
      expect(settled.outcome).toMatchObject({
        kind: "replayed",
        requests: 3,
        sockets: 2,
      });
    });
  });

  test("a replay that arrived before arming is waited on too", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness();
      define(h, "a");
      await h.subscribeBatch([{ key: "a" }], { tabId: "t1", epoch: OLD_EPOCH });
      const settled = watch(h.runtime.replaySettled());
      await clock.advance(quietMs);
      expect(settled.outcome).toMatchObject({ kind: "replayed", requests: 1 });
    });
  });

  test("an unanswered request holds it to the ceiling, which names what was owed", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness();
      const slow = controllable("v");
      slow.block();
      h.runtime.defineExternalResource({
        key: "slow",
        mode: "push",
        schema: z.string(),
        loader: slow.loader,
      });
      define(h, "a");
      const settled = watch(h.runtime.replaySettled());
      await h.subscribeBatch([{ key: "slow" }, { key: "a" }], {
        tabId: "t1",
        epoch: OLD_EPOCH,
      });
      await clock.advance(ceilingMs - 1);
      expect(settled.outcome).toBeNull();
      await clock.advance(1);
      expect(settled.outcome).toMatchObject({
        kind: "ceiling",
        requests: 2,
        owed: 1,
      });
      slow.release();
    });
  });

  test("a closed socket stops owing its requests", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness();
      const slow = controllable("v");
      slow.block();
      h.runtime.defineExternalResource({
        key: "slow",
        mode: "push",
        schema: z.string(),
        loader: slow.loader,
      });
      const settled = watch(h.runtime.replaySettled());
      await h.subscribeBatch([{ key: "slow" }], {
        tabId: "t1",
        epoch: OLD_EPOCH,
      });
      await clock.advance(quietMs * 2);
      expect(settled.outcome).toBeNull();
      h.closeSocket(0);
      await clock.advance(quietMs);
      expect(settled.outcome?.kind).toBe("replayed");
      slow.release();
    });
  });

  test("an unsub stops owing the tab's request for that tuple", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness();
      const slow = controllable("v");
      slow.block();
      h.runtime.defineExternalResource({
        key: "slow",
        mode: "push",
        schema: z.string(),
        loader: slow.loader,
      });
      const settled = watch(h.runtime.replaySettled());
      await h.subscribeBatch([{ key: "slow" }], {
        tabId: "t1",
        epoch: OLD_EPOCH,
      });
      await clock.advance(quietMs * 2);
      expect(settled.outcome).toBeNull();
      await h.unsub("slow", {}, { tabId: "t1" });
      await clock.advance(quietMs * 2);
      expect(settled.outcome?.kind).toBe("replayed");
      slow.release();
    });
  });

  test("never armed: tracking ends at the ceiling from the first replay request", async () => {
    await withFakeClock(async (clock) => {
      const h = createHarness();
      const slow = controllable("v");
      slow.block();
      h.runtime.defineExternalResource({
        key: "slow",
        mode: "push",
        schema: z.string(),
        loader: slow.loader,
      });
      await h.subscribeBatch([{ key: "slow" }], {
        tabId: "t1",
        epoch: OLD_EPOCH,
      });
      await clock.advance(ceilingMs);
      // Already settled when someone asks: nothing is still held.
      const settled = watch(h.runtime.replaySettled());
      await clock.advance(0);
      expect(settled.outcome).toMatchObject({
        kind: "ceiling",
        requests: 1,
        owed: 1,
      });
      slow.release();
    });
  });
});
