/**
 * What does metering every file call as it starts cost a fast one?
 *
 *   ./equin run plugins/infra/plugins/runtime-profiler/scripts/fs-meter-bench.ts
 *
 * Runs N real calls (`stat` awaited, `statSync`) inside three nested entries,
 * under four meters: none, the deferred wait the server installs
 * (`beginDeferredWait`: a Set add / delete), and an eager `beginWait` (an
 * ancestor walk at each start and end) for comparison — plus each meter alone
 * in a tight loop, with no file call, to isolate its own cost.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import {
  FS_WAIT_FLOOR_MS,
  installFsWaitMeter,
  stat,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  beginDeferredWait,
  beginWait,
  installSpanContextRuntime,
  recordEntrySpan,
  type EntryContext,
} from "../core";

const ASYNC_N = 20_000;
const SYNC_N = 100_000;
const LOOP_N = 1_000_000;
const ROUNDS = 5;
const PATH = import.meta.path;

const als = new AsyncLocalStorage<EntryContext>();
installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

const METERS = {
  none: null,
  deferred: (layer: string) => beginDeferredWait(layer, "io", FS_WAIT_FLOOR_MS),
  eager: (layer: string) => beginWait(layer, "io"),
} as const;

async function nsPer(n: number, body: () => unknown): Promise<number> {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < n; i++) await body();
  return (Bun.nanoseconds() - t0) / n;
}

function nsPerSync(n: number, body: () => unknown): number {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < n; i++) body();
  return (Bun.nanoseconds() - t0) / n;
}

const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!;

async function inEntries<T>(fn: () => Promise<T>): Promise<T> {
  return recordEntrySpan("loader", "bench:outer", () =>
    recordEntrySpan("loader", "bench:mid", () =>
      recordEntrySpan("loader", "bench:inner", fn),
    ),
  );
}

const rows: Record<string, Record<string, number>> = {};
for (const [name, meter] of Object.entries(METERS)) {
  installFsWaitMeter(meter);
  const a: number[] = [];
  const s: number[] = [];
  const l: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    await inEntries(async () => {
      a.push(await nsPer(ASYNC_N, () => stat(PATH)));
      s.push(nsPerSync(SYNC_N, () => statSync(PATH)));
      if (meter) l.push(nsPerSync(LOOP_N, () => meter("fs-stat")()));
    });
  }
  rows[name] = {
    "stat (ns)": median(a),
    "statSync (ns)": median(s),
    "meter alone (ns)": meter ? median(l) : 0,
  };
}
installFsWaitMeter(null);
const raw: Record<string, number> = { "meter alone (ns)": 0 };
await inEntries(async () => {
  const a: number[] = [];
  const s: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    a.push(await nsPer(ASYNC_N, () => fsp.stat(PATH)));
    s.push(nsPerSync(SYNC_N, () => fs.statSync(PATH)));
  }
  raw["stat (ns)"] = median(a);
  raw["statSync (ns)"] = median(s);
});
console.table({ "node:fs (untimed)": raw, ...rows });
