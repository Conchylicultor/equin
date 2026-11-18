/**
 * Central's entry installs the use-scoped slot scope, so a central read holds
 * its read-admission slot only around its own resource uses — a wait on
 * anything else frees it (resource-runtime CLAUDE.md, *A slot covers only its
 * uses*) — as on a worktree server, whose profiler installs the same scope.
 */
import { afterAll, expect, test } from "bun:test";
import "./lease-scope";
import {
  createSemaphore,
  installLeaseContextRuntime,
} from "@plugins/packages/plugins/semaphore/core";

// The entry installs its scope for the whole process; a suite sharing the
// process after this one must see the host it asks for.
afterAll(() => installLeaseContextRuntime(null));

test("a body waiting on another caller's work holds no slot while it waits", async () => {
  const gate = createSemaphore(1);
  let release!: () => void;
  const elsewhere = new Promise<void>((resolve) => (release = resolve));
  const waiter = gate.run(
    async () => {
      await elsewhere;
      return "waiter";
    },
    { heldFor: ["db", "fs"] },
  );
  // The only slot was the waiter's: without the scope this run would queue
  // behind a wait that never ends.
  expect(await gate.run(() => Promise.resolve("unrelated"))).toBe("unrelated");
  release();
  expect(await waiter).toBe("waiter");
});
