/**
 * How long unrelated live reads wait while one read is slow — the read
 * admission gate with and without yieldable slots.
 *
 *   ./equin run plugins/framework/plugins/resource-runtime/scripts/read-admit-bench.ts
 *
 * One shared read takes SLOW_MS (the transcript); six derived values join it;
 * then UNRELATED reads (each a 5 ms loader) subscribe. "held" is the runtime
 * with no lease scope installed — `whileWaiting` is a passthrough, so a joiner
 * keeps its slot (the behaviour before yieldable slots); "yielded" installs the
 * AsyncLocalStorage scope `runtime-profiler/server` installs at boot.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import {
  installLeaseContextRuntime,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";
import { createHarness } from "../core/test-support";

const SLOW_MS = 2000;
const DERIVED = 6;
const UNRELATED = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(label: string): Promise<void> {
  const h = createHarness();
  const memo = createInflight();
  const transcript = () => memo.run("t", () => sleep(SLOW_MS).then(() => "e"));
  for (let i = 0; i < DERIVED; i++) {
    h.runtime.defineExternalResource({
      key: `derived-${i}`,
      mode: "push",
      schema: z.string(),
      loader: async () => `${await transcript()}${i}`,
    });
  }
  for (let i = 0; i < UNRELATED; i++) {
    h.runtime.defineExternalResource({
      key: `unrelated-${i}`,
      mode: "push",
      schema: z.string(),
      loader: () => sleep(5).then(() => "u"),
    });
  }
  // Stamp each sub-ack as the socket receives it.
  const ackedAt = new Map<string, number>();
  let allAcked!: () => void;
  const done = new Promise<void>((r) => (allAcked = r));
  const push = h.frames.push.bind(h.frames);
  h.frames.push = (...frames) => {
    for (const f of frames) {
      if (f.kind === "sub-ack" && f.key !== undefined) {
        ackedAt.set(f.key, performance.now() - t0);
      }
    }
    if (ackedAt.size === DERIVED + UNRELATED) allAcked();
    return push(...frames);
  };
  const t0 = performance.now();
  const slow = transcript(); // the watcher's read, outside any slot
  for (let i = 0; i < DERIVED; i++) await h.subscribe(`derived-${i}`);
  for (let i = 0; i < UNRELATED; i++) await h.subscribe(`unrelated-${i}`);
  await done;
  await slow;
  const of = (prefix: string) =>
    [...ackedAt].filter(([k]) => k.startsWith(prefix)).map(([, ms]) => ms);
  const unrelated = of("unrelated-").sort((a, b) => a - b);
  const derived = of("derived-");
  const fmt = (ms: number) => `${ms.toFixed(0)} ms`;
  console.log(
    `${label.padEnd(8)} unrelated ack: median ${fmt(unrelated[Math.floor(unrelated.length / 2)]!)}, max ${fmt(unrelated.at(-1)!)} | derived ack: max ${fmt(Math.max(...derived))}`,
  );
}

await run("held");
const als = new AsyncLocalStorage<LeaseScope>();
installLeaseContextRuntime({
  run: (scope, fn) => als.run(scope, fn),
  current: () => als.getStore(),
});
await run("yielded");
// The harness runtime's heartbeat timer would keep the process alive.
process.exit(0);
