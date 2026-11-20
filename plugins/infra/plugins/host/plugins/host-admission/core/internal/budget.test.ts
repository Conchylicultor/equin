import { test, expect } from "bun:test";
import {
  cpuBudget,
  hostCpuCeiling,
  hostRamCeiling,
  PER_UNIT_BYTES,
  rawFleetCeiling,
  rigidShareFit,
} from "./budget";

// `budget.ts` is pure `node:os` arithmetic — it touches no flock file and no
// pool, so it gets its own suite rather than riding along in `grant.test.ts`,
// whose tests drive the real host `cpu` pool.
//
// Every assertion is written against the host's OWN facts rather than this box's
// numbers, so the suite passes on an 18-core Mac, a 4-core VPS and CI alike. It
// is deliberately a restatement of the formula: the property under test is not
// "B is 9", it is that `B` is derived from host facts and the RAM quantum and
// from NOTHING ELSE — in particular nothing from `HOST_POOLS`. Before
// 2026-09-09 the pool table subtracted a reserved CPU cost here, which is what
// let a pool's declaration silently move the fleet ceiling (and let the same core
// be charged twice). Re-introducing any such term makes this fail.

test("B is a pure function of host facts and the quantum — nothing from the pool table", () => {
  expect(cpuBudget().B).toBe(
    Math.max(
      1,
      Math.min(hostCpuCeiling(), Math.floor(hostRamCeiling() / PER_UNIT_BYTES)),
    ),
  );
});

test("rawFleetCeiling is the pre-floor value B floors", () => {
  const raw = rawFleetCeiling();
  expect(raw).toBe(
    Math.min(hostCpuCeiling(), Math.floor(hostRamCeiling() / PER_UNIT_BYTES)),
  );
  // The floor is the ONLY difference between the two, and it only bites on a host
  // holding less than one quantum of usable RAM.
  expect(cpuBudget().B).toBe(Math.max(1, raw));
});

test("the lane split never leaves a lane with a zero window", () => {
  // A zero-width lane is a deadlocked pool `defineHostPool` refuses to build —
  // which once made the app unbootable on a small host rather than merely slow.
  const { B, reservedInteractive, backgroundLimit } = cpuBudget();
  expect(B).toBeGreaterThanOrEqual(1);
  expect(reservedInteractive).toBeGreaterThanOrEqual(1);
  expect(backgroundLimit).toBeGreaterThanOrEqual(1);
  expect(reservedInteractive).toBeLessThanOrEqual(B);
});

// A rigid share is a static fact of the host: these hosts are fixed, not this box.
const GiB = 2 ** 30;
const mac16 = { cpus: 10, ramBytes: 16 * GiB };
const mac64 = { cpus: 18, ramBytes: 64 * GiB };

test("a rigid share wider than the lane's static window never fits, and names the host it needs", () => {
  // 16 GB: B = 2, the background lane holds 1.
  const fit = rigidShareFit({ lane: "background", units: 5 }, mac16);
  if (fit.fits)
    throw new Error(
      "expected a 5-slot background share not to fit a 16 GB host",
    );
  expect(fit.ceiling).toBe(cpuBudget(mac16).backgroundLimit);
  // The smallest host whose background lane holds 5: B = 7 (2 reserved).
  expect(fit.needs.cpus).toBe(7);
  expect(cpuBudget(fit.needs).backgroundLimit).toBeGreaterThanOrEqual(5);
  // …and one quantum less RAM would not do.
  expect(
    cpuBudget({ cpus: 7, ramBytes: fit.needs.ramBytes - PER_UNIT_BYTES * 2 })
      .backgroundLimit,
  ).toBeLessThan(5);
  expect(fit.words).toContain("at least 47 GB of RAM and 7 cores");
  expect(fit.words).toContain("this one has 16 GB and 10 cores");
});

test("a rigid share within the lane's static window fits", () => {
  // 64 GB: B = 9, the background lane holds 6.
  expect(rigidShareFit({ lane: "background", units: 5 }, mac64).fits).toBe(
    true,
  );
  expect(rigidShareFit({ lane: "background", units: 1 }, mac16).fits).toBe(
    true,
  );
  expect(rigidShareFit({ lane: "interactive", units: 2 }, mac16).fits).toBe(
    true,
  );
});
