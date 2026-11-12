import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeliveryLagProbe,
  splitDeliveryLag,
  type DeliveryLagSample,
} from "./delivery-lag";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "delivery-lag-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The host's reader, as the server's (`define.ts`) is: a missing path is null.
const ctimeOf = async (path: string): Promise<number | null> => {
  try {
    return (await lstat(path)).ctimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

// A process and a watch both started long ago: every write here is after them.
const host = { ctimeOf, wokeBetween: () => false, startedAt: 0 };
const ARMED_LONG_AGO = 0;

// The probe's stat runs detached; wait for the microtask/IO turn it needs.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("createDeliveryLagProbe", () => {
  test("reads arrival − ctime on the batch's newest written path", async () => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, "x\n");
    const samples: DeliveryLagSample[] = [];
    const probe = createDeliveryLagProbe(host, ARMED_LONG_AGO, (s) =>
      samples.push(s),
    );
    const arrivedAt = Date.now() + 3000; // heard 3 s after the write
    probe(
      [
        { type: "update", path: file },
        { type: "delete", path: join(dir, "gone") },
      ],
      arrivedAt,
    );
    await settle();
    expect(samples).toHaveLength(1);
    expect(samples[0]!.path).toBe(file);
    expect(samples[0]!.lagMs).toBeGreaterThanOrEqual(2900);
    expect(samples[0]!.lagMs).toBeLessThan(4000);
    expect(samples[0]!.beforeArm).toBeUndefined();
  });

  test("a write older than the watch's arming is split, not timed as delivery", async () => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, "x\n");
    const ctime = (await lstat(file)).ctimeMs;
    const samples: DeliveryLagSample[] = [];
    // The process started 1 s after the write, the watch armed 10 s after it,
    // and the write arrived 2 s after arming.
    const probe = createDeliveryLagProbe(
      { ctimeOf, wokeBetween: () => false, startedAt: ctime + 1000 },
      ctime + 10_000,
      (s) => samples.push(s),
    );
    probe([{ type: "update", path: file }], ctime + 12_000);
    await settle();
    expect(samples).toEqual([
      {
        path: file,
        writtenAt: ctime,
        arrivedAt: ctime + 12_000,
        lagMs: 2000,
        beforeArm: { beforeStartMs: 1000, armMs: 9000 },
      },
    ]);
  });

  test("one sample per interval, and none for a delete-only batch", async () => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, "x\n");
    const samples: DeliveryLagSample[] = [];
    const probe = createDeliveryLagProbe(
      host,
      ARMED_LONG_AGO,
      (s) => samples.push(s),
      1000,
    );
    const t = Date.now() + 10;
    probe([{ type: "delete", path: file }], t);
    probe([{ type: "update", path: file }], t);
    await settle();
    probe([{ type: "update", path: file }], t + 500); // inside the interval
    await settle();
    probe([{ type: "update", path: file }], t + 1500);
    await settle();
    expect(samples.map((s) => s.arrivedAt)).toEqual([t, t + 1500]);
  });

  test("a path changed after its arrival, or gone, says nothing", async () => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, "x\n");
    const samples: DeliveryLagSample[] = [];
    const probe = createDeliveryLagProbe(
      host,
      ARMED_LONG_AGO,
      (s) => samples.push(s),
      0,
    );
    probe([{ type: "update", path: file }], Date.now() - 5000);
    await settle();
    probe([{ type: "create", path: join(dir, "missing") }], Date.now());
    await settle();
    expect(samples).toEqual([]);
  });

  test("a write made before the machine slept is not the watch's lag", async () => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, "x\n");
    const samples: DeliveryLagSample[] = [];
    const probe = createDeliveryLagProbe(
      { ctimeOf, wokeBetween: () => true, startedAt: 0 },
      ARMED_LONG_AGO,
      (s) => samples.push(s),
    );
    probe([{ type: "update", path: file }], Date.now() + 60_000);
    await settle();
    expect(samples).toEqual([]);
  });
});

describe("splitDeliveryLag", () => {
  const times = { startedAt: 100_000, armedAt: 113_000 };
  const parts = (s: DeliveryLagSample) =>
    s.lagMs + (s.beforeArm?.armMs ?? 0) + (s.beforeArm?.beforeStartMs ?? 0);

  test("a write after arming is all delivery", () => {
    const s = splitDeliveryLag("p", 120_000, 125_000, times);
    expect(s).toEqual({
      path: "p",
      writtenAt: 120_000,
      arrivedAt: 125_000,
      lagMs: 5000,
    });
  });

  test("a write while the backend booted: time to arm, then delivery", () => {
    const s = splitDeliveryLag("p", 105_000, 114_000, times);
    expect(s.lagMs).toBe(1000);
    expect(s.beforeArm).toEqual({ beforeStartMs: 0, armMs: 8000 });
  });

  test("a write before the backend started: all three parts, summing to the whole", () => {
    // The 2026-11-12 shape: written 2 min before a main restart, heard 13 s
    // after it — 13 s of boot before arming, 0.4 s of delivery.
    const s = splitDeliveryLag("p", -20_000, 113_400, times);
    expect(s.lagMs).toBe(400);
    expect(s.beforeArm).toEqual({ beforeStartMs: 120_000, armMs: 13_000 });
    expect(parts(s)).toBe(133_400);
  });

  test("a long delivery after arming stays delivery, whatever the write's age", () => {
    // Pre-start write, but fseventsd held it 400 s past arming: that is the
    // watch's lag, and it is not excused.
    const s = splitDeliveryLag("p", 90_000, 513_000, times);
    expect(s.lagMs).toBe(400_000);
    expect(parts(s)).toBe(423_000);
  });
});
