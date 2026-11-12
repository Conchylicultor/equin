/**
 * Central's entry installs the yieldable-slot scope, so a central read that
 * only waits on another caller's work gives its read-admission slot back
 * (resource-runtime CLAUDE.md, *Waiters hold no slot*) — as on a worktree
 * server, whose profiler installs the same scope.
 */
import { expect, test } from "bun:test";
import "./lease-scope";
import {
  createSemaphore,
  whileWaiting,
} from "@plugins/packages/plugins/semaphore/core";

test("a body waiting on another caller's work frees its slot for the wait", async () => {
  const gate = createSemaphore(1);
  let release!: () => void;
  const elsewhere = new Promise<void>((resolve) => (release = resolve));
  let waiting!: () => void;
  const started = new Promise<void>((resolve) => (waiting = resolve));
  const waiter = gate.run(
    async () => {
      const wait = whileWaiting(elsewhere);
      waiting();
      await wait;
      return "waiter";
    },
    { yieldable: true },
  );
  await started;
  // The only slot is the waiter's: without the scope this run would queue
  // behind a wait that never ends.
  expect(await gate.run(() => Promise.resolve("unrelated"))).toBe("unrelated");
  release();
  expect(await waiter).toBe("waiter");
});
