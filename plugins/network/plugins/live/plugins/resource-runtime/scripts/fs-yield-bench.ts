/**
 * Should a live read give its read-admit slot back while ITS OWN file call is
 * pending (`installFsAwait((p) => whileWaiting(p))`)?
 *
 *   ./equin run plugins/network/plugins/live/plugins/resource-runtime/scripts/fs-yield-bench.ts
 *
 * Two scenarios, each with the slot held (no wrap) and yielded (wrap):
 * - stall: one read's stat stalls STALL_MS (a stalled disk), then 30
 *   unrelated 5 ms reads subscribe — how long do they wait?
 * - herd: 60 reads each make 40 real `stat` calls, all subscribing at once
 *   (the read-admit gate contended) — how long until the last is acked, and
 *   how many fs calls ran at once?
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import {
  installLeaseContextRuntime,
  whileWaiting,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";
import { installFsAwait, stat } from "@plugins/packages/plugins/timed-fs/core";
import { createHarness } from "../core/test-support";

const STALL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stallNext = false;
let inFs = 0;
let maxInFs = 0;
const counted = <T>(p: Promise<T>): Promise<T> => {
  inFs++;
  maxInFs = Math.max(maxInFs, inFs);
  return p.finally(() => inFs--);
};
const stalled = <T>(p: Promise<T>): Promise<T> => {
  if (!stallNext) return counted(p);
  stallNext = false;
  return counted(sleep(STALL_MS).then(() => p));
};

async function acks(
  defs: { key: string; loader: () => Promise<string> }[],
): Promise<Map<string, number>> {
  const h = createHarness();
  for (const d of defs)
    h.runtime.defineExternalResource({
      key: d.key,
      mode: "push",
      schema: z.string(),
      loader: d.loader,
    });
  const ackedAt = new Map<string, number>();
  let all!: () => void;
  const done = new Promise<void>((r) => (all = r));
  const push = h.frames.push.bind(h.frames);
  h.frames.push = (...frames) => {
    for (const f of frames)
      if (f.kind === "sub-ack" && f.key !== undefined)
        ackedAt.set(f.key, performance.now() - t0);
    if (ackedAt.size === defs.length) all();
    return push(...frames);
  };
  const t0 = performance.now();
  for (const d of defs) await h.subscribe(d.key);
  await done;
  return ackedAt;
}

const median = (xs: number[]) =>
  xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function stallScenario(label: string): Promise<void> {
  const defs = [
    {
      key: "stalled",
      loader: async () => {
        stallNext = true;
        await stat(import.meta.dir);
        return "s";
      },
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      key: `unrelated-${i}`,
      loader: () => sleep(5).then(() => "u"),
    })),
  ];
  // 6 slots: five more stalled reads fill the gate the way main's did.
  for (let i = 0; i < 5; i++)
    defs.splice(1, 0, {
      key: `stalled-${i}`,
      loader: async () => {
        stallNext = true;
        await stat(import.meta.dir);
        return "s";
      },
    });
  const a = await acks(defs);
  const un = [...a]
    .filter(([k]) => k.startsWith("unrelated-"))
    .map(([, v]) => v);
  console.log(
    `stall ${label.padEnd(8)} unrelated ack: median ${median(un).toFixed(0)} ms, max ${Math.max(...un).toFixed(0)} ms`,
  );
}

async function herdScenario(label: string): Promise<void> {
  maxInFs = 0;
  const defs = Array.from({ length: 60 }, (_, i) => ({
    key: `herd-${i}`,
    loader: async () => {
      for (let j = 0; j < 40; j++) await stat(import.meta.dir);
      return "h";
    },
  }));
  const t0 = performance.now();
  const a = await acks(defs);
  console.log(
    `herd  ${label.padEnd(8)} last ack ${Math.max(...a.values()).toFixed(0)} ms (wall ${(performance.now() - t0).toFixed(0)} ms), median ${median([...a.values()]).toFixed(0)} ms, fs calls in flight at once: max ${maxInFs}`,
  );
}

const als = new AsyncLocalStorage<LeaseScope>();
installLeaseContextRuntime({
  run: (scope, fn) => als.run(scope, fn),
  current: () => als.getStore(),
});

for (let round = 0; round < 3; round++) {
  installFsAwait(stalled);
  await stallScenario("held");
  await herdScenario("held");
  installFsAwait((p) => whileWaiting(stalled(p)));
  await stallScenario("yielded");
  await herdScenario("yielded");
}
process.exit(0);
