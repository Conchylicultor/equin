import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createSemaphore,
  installLeaseContextRuntime,
  usingSlot,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";
import { createKeyedMutex } from "./keyed-mutex";

// A key held across a wait inside a use-scoped gate slot (a live read): the
// 2026-11-17 `cost-at` wedge, reproduced at the primitives.

beforeAll(() => {
  const als = new AsyncLocalStorage<LeaseScope>();
  installLeaseContextRuntime({
    run: (scope, fn) => als.run(scope, fn),
    current: () => als.getStore(),
  });
});
afterAll(() => installLeaseContextRuntime(null));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("keyed mutex inside a use-scoped gate", () => {
  test("a holder's file wait and a queue of waiters never wedge the gate", async () => {
    const gate = createSemaphore(2);
    const mutex = createKeyedMutex();
    const disk = deferred<string>();
    const order: string[] = [];
    // One read holds the key and waits on the disk (a timed-fs call — a use
    // holding the read's slot); three more reads queue on the same key.
    const reads = ["a", "b", "c", "d"].map((name) =>
      gate.run(
        () =>
          mutex.run("conv", async () => {
            order.push(`${name}:run`);
            if (name === "a")
              order.push(await usingSlot("fs", () => disk.promise));
          }),
        { heldFor: ["db", "fs"] },
      ),
    );
    await flush();
    // Only the holder's disk call holds a slot; the waiters on the key hold
    // none, so the gate is not full of reads waiting on one another.
    expect(gate.stats().active).toBe(1);
    // An unrelated read is admitted at once.
    const other = deferred();
    const unrelated = gate.run(async () => {
      order.push("other:run");
      await other.promise;
    });
    await flush();
    expect(order).toEqual(["a:run", "other:run"]);
    disk.resolve("a:disk");
    other.resolve();
    await Promise.all([...reads, unrelated]);
    expect(order).toEqual([
      "a:run",
      "other:run",
      "a:disk",
      "b:run",
      "c:run",
      "d:run",
    ]);
    expect(gate.stats()).toEqual({ active: 0, queued: 0, max: 2, holders: [] });
  });

  test("an aborted waiter rejects holding no slot", async () => {
    const gate = createSemaphore(1);
    const mutex = createKeyedMutex();
    const held = deferred();
    const first = mutex.run("k", () => held.promise);
    const controller = new AbortController();
    let activeAtReject = -1;
    const waiter = gate.run(
      async () => {
        try {
          await mutex.run("k", async () => {}, { signal: controller.signal });
        } finally {
          activeAtReject = gate.stats().active;
        }
      },
      { heldFor: ["db", "fs"] },
    );
    await flush();
    expect(gate.stats().active).toBe(0);
    controller.abort(new Error("gave up"));
    expect(waiter).rejects.toThrow("gave up");
    await flush();
    expect(activeAtReject).toBe(0);
    held.resolve();
    await first;
    expect(mutex.size).toBe(0);
  });
});
