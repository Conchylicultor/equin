/**
 * The post-restart resubscribe herd, in miniature: how long cheap reads wait
 * at the read-admission gate while the edited-files readers of every open
 * conversation wait on their worktrees' first watch pass.
 *
 *   ./equin run plugins/network/plugins/live/plugins/resource-runtime/scripts/read-cost-bench.ts
 *
 * WORKTREES watched memos open at once; each one's pass 1 (`git status` +
 * `git diff`) takes PASS_MS. Each worktree has two readers (the pages and the
 * meta). Then MEMORY reads (an icon sprite, a config value: a memo slice) and
 * IO reads (a 5 ms query) subscribe.
 *
 * - "before": no lease scope (`whileWaiting` is a passthrough — a memo
 *   waiter keeps its slot, as `watched-memo`'s pass-1 wait did) and the
 *   memory reads undeclared;
 * - "after": the server's lease scope, and the memory reads declared
 *   `readCost: "memory"`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { createWatchedMemo } from "@plugins/packages/plugins/watched-memo/core";
import {
  installLeaseContextRuntime,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";
import { createHarness } from "../core/test-support";

const PASS_MS = 1500;
const WORKTREES = 6;
const MEMORY = 20;
const IO = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(label: string, after: boolean): Promise<void> {
  const h = createHarness();
  const memo = createWatchedMemo<string, string>({
    name: "bench",
    facts: () => sleep(PASS_MS).then(() => "f"),
    signatureOf: () => Promise.resolve("s"),
    compute: (_k, f) => Promise.resolve(f),
    changes: () => Promise.resolve(() => {}),
  });
  const keys: string[] = [];
  for (let w = 0; w < WORKTREES; w++) {
    for (const part of ["pages", "meta"]) {
      const key = `edited-${part}-${w}`;
      keys.push(key);
      h.runtime.defineExternalResource({
        key,
        mode: "push",
        schema: z.string(),
        loader: () => memo.get(`wt${w}`),
      });
    }
  }
  for (let i = 0; i < MEMORY; i++) {
    keys.push(`memory-${i}`);
    h.runtime.defineExternalResource({
      key: `memory-${i}`,
      mode: "push",
      schema: z.string(),
      ...(after ? { readCost: "memory" as const } : {}),
      loader: () => Promise.resolve("m"),
    });
  }
  for (let i = 0; i < IO; i++) {
    keys.push(`io-${i}`);
    h.runtime.defineExternalResource({
      key: `io-${i}`,
      mode: "push",
      schema: z.string(),
      loader: () => sleep(5).then(() => "i"),
    });
  }
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
    if (ackedAt.size === keys.length) allAcked();
    return push(...frames);
  };
  const t0 = performance.now();
  // The watches open outside any slot (`whileFollowing` starts).
  const stops = await Promise.all(
    Array.from({ length: WORKTREES }, (_, w) => memo.watch(`wt${w}`, () => {})),
  );
  for (const key of keys) await h.subscribe(key);
  await done;
  for (const stop of stops) stop();
  const of = (prefix: string) =>
    [...ackedAt]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, ms]) => ms)
      .sort((a, b) => a - b);
  const fmt = (ms: number[]) =>
    `median ${ms[Math.floor(ms.length / 2)]!.toFixed(0)} ms, max ${ms.at(-1)!.toFixed(0)} ms`;
  console.log(
    `${label.padEnd(7)} memory ack: ${fmt(of("memory-"))} | io ack: ${fmt(of("io-"))} | edited ack: ${fmt(of("edited-"))}`,
  );
}

await run("before", false);
const als = new AsyncLocalStorage<LeaseScope>();
installLeaseContextRuntime({
  run: (scope, fn) => als.run(scope, fn),
  current: () => als.getStore(),
});
await run("after", true);
// The harness runtime's heartbeat timer would keep the process alive.
process.exit(0);
