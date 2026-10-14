/**
 * Gate-after-dedup — the read-admission gate is acquired INSIDE the read-path
 * single-flight, so only the STARTER of a flight occupies a slot. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-gate-dedup.test.ts`.
 *
 * Before this, `gatedRead` admitted BEFORE the dedup: N replayed subs of one
 * (key, params) each burned a slot while N−1 of them would only coalesce — the
 * "joiners burn read-admit slots" convoy of
 * research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md
 * Finding 3 (5,242 queued sub spans at 9.8s average wait). These tests pin the
 * new containment: same-pk concurrency costs ONE slot and ONE loader run;
 * distinct pks are still capped at the gate size; and the etag-seeding
 * co-production contract (`runtime-revalidate.test.ts`) holds through the moved
 * gate.
 */

import { test, expect, describe } from "bun:test";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import { z } from "zod";
import { createHarness, controllable, tick } from "./test-support";

const sig = (raw: string): string => hashHex(raw);

describe("gate-after-dedup — read-admission inside the single-flight", () => {
  test("N same-pk subs on a parked loader: gate active === 1, one loader run, all acked", async () => {
    const h = createHarness({ sockets: 3 });
    let loads = 0;
    const ctl = controllable("v1");
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => {
        loads++;
        return ctl.loader();
      },
    });

    ctl.block();
    await h.subscribe("r", {}, { socket: 0 }); // starter — takes the one slot
    await h.subscribe("r", {}, { socket: 1 }); // joiner — coalesces, NO slot
    await h.subscribe("r", {}, { socket: 2 }); // joiner — coalesces, NO slot

    const stats = h.runtime.readGateStats();
    expect(stats.active).toBe(1); // one flight, one slot — never three
    expect(stats.queued).toBe(0); // joiners never queue at the gate
    expect(loads).toBe(1);

    ctl.release();
    await tick();
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(3);
    expect(loads).toBe(1); // one shared flight served all three
    expect(h.runtime.readGateStats().active).toBe(0); // slot released
  });

  test("N distinct-pk parked loads: gate active capped at the gate size", async () => {
    const h = createHarness();
    const ctl = controllable("v");
    h.runtime.defineExternalResource<string, { i: string }>({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: () => ctl.loader(),
    });

    ctl.block();
    for (let i = 0; i < 8; i++) {
      await h.subscribe("r", { i: String(i) }); // 8 distinct pks → 8 flights
    }
    const stats = h.runtime.readGateStats();
    expect(stats.max).toBe(6); // READ_LOAD_CONCURRENCY
    expect(stats.active).toBe(6); // admission still bounds distinct cold loads
    expect(stats.queued).toBe(2);

    ctl.release();
    await tick();
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(8);
    expect(h.runtime.readGateStats().active).toBe(0);
  });

  test("etag seeding contract holds through the moved gate: a joiner adopts the starter's seed", async () => {
    // The co-production invariant of runtime-revalidate.test.ts, re-asserted
    // against the gate-inside-the-flight structure: the flight resolves the etag
    // it was SEEDED with, so a joiner that probed a newer signature still stamps
    // the starter's older one (safe direction — never a newer etag on an older
    // value).
    const h = createHarness({ sockets: 2 });
    let gitState = 1;
    const ctl = controllable("v1");
    h.runtime.defineExternalResource({
      key: "edited",
      mode: "invalidate",
      schema: z.string(),
      loader: ctl.loader,
      revalidate: async () => String(gitState),
    });

    ctl.block();
    await h.subscribe("edited", {}, { socket: 0 }); // starter probes sig("1")
    gitState = 2;
    await h.subscribe("edited", {}, { socket: 1 }); // joiner probes sig("2"), coalesces
    ctl.release();
    await tick();

    const starterAck = h.frames.find(
      (f) => f.socket === 0 && f.kind === "sub-ack",
    )!;
    const joinerAck = h.frames.find(
      (f) => f.socket === 1 && f.kind === "sub-ack",
    )!;
    expect(starterAck.value).toBe("v1");
    expect(joinerAck.value).toBe("v1"); // one loader run served both
    expect(starterAck.etag).toBe(sig("1"));
    expect(joinerAck.etag).toBe(sig("1")); // the starter's seed, never the joiner's own
  });
});
