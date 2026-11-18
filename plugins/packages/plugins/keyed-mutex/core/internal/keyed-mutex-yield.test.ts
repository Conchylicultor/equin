import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createSemaphore,
  installLeaseContextRuntime,
  usingSlot,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";
import { createKeyedMutex } from "./keyed-mutex";

beforeAll(() => {
  const als = new AsyncLocalStorage<LeaseScope>();
  installLeaseContextRuntime({
    run: (scope, fn) => als.run(scope, fn),
    current: () => als.getStore(),
  });
});
afterAll(() => installLeaseContextRuntime(null));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

// main, 2026-11-17 11:17Z: the holder of a lock yielded its read slot for a
// file call; a second caller of the same lock took the slot and queued for the
// lock while holding it; the holder could never take its slot back. With
// use-scoped slots a caller queued for the lock holds none to begin with.
test("a caller queued for the lock holds no use-scoped slot, so the holder can resume", async () => {
  const gate = createSemaphore(1);
  const mutex = createKeyedMutex();
  const io = deferred();
  const order: string[] = [];
  const a = gate.run(
    () =>
      mutex.run("k", async () => {
        order.push("a:locked");
        await usingSlot("fs", () => io.promise); // a file call: holds the slot
        order.push("a:done");
      }),
    { heldFor: ["db", "fs"] },
  );
  await flush();
  const b = gate.run(
    () =>
      mutex.run("k", async () => {
        order.push("b:locked");
      }),
    { heldFor: ["db", "fs"] },
  );
  await flush();
  io.resolve();
  await Promise.all([a, b]);
  expect(order).toEqual(["a:locked", "a:done", "b:locked"]);
  expect(gate.stats()).toEqual({ active: 0, queued: 0, max: 1, holders: [] });
});
