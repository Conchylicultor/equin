import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryLagProbe, type DeliveryLagSample } from "./delivery-lag";

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

const host = { ctimeOf, wokeBetween: () => false };

// The probe's stat runs detached; wait for the microtask/IO turn it needs.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("createDeliveryLagProbe", () => {
  test("reads arrival − ctime on the batch's newest written path", async () => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, "x\n");
    const samples: DeliveryLagSample[] = [];
    const probe = createDeliveryLagProbe(host, (s) => samples.push(s));
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
  });

  test("one sample per interval, and none for a delete-only batch", async () => {
    const file = join(dir, "a.jsonl");
    await writeFile(file, "x\n");
    const samples: DeliveryLagSample[] = [];
    const probe = createDeliveryLagProbe(host, (s) => samples.push(s), 1000);
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
    const probe = createDeliveryLagProbe(host, (s) => samples.push(s), 0);
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
      { ctimeOf, wokeBetween: () => true },
      (s) => samples.push(s),
    );
    probe([{ type: "update", path: file }], Date.now() + 60_000);
    await settle();
    expect(samples).toEqual([]);
  });
});
