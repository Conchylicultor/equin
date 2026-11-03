import { AsyncLocalStorage } from "node:async_hooks";
import { test, expect, describe, beforeAll } from "bun:test";
import { createSemaphore } from "./semaphore";
import {
  installLeaseContextRuntime,
  whileWaiting,
  type LeaseScope,
} from "./lease-scope";

beforeAll(() => {
  const als = new AsyncLocalStorage<LeaseScope>();
  installLeaseContextRuntime({
    run: (scope, fn) => als.run(scope, fn),
    current: () => als.getStore(),
  });
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("yieldable slots", () => {
  test("a waiting holder frees its slot; the next caller runs; the holder resumes ahead of newcomers", async () => {
    const gate = createSemaphore(1);
    const other = deferred<string>();
    const order: string[] = [];
    const a = gate.run(
      async () => {
        order.push("a:start");
        const v = await whileWaiting(other.promise);
        order.push(`a:resumed:${v}`);
      },
      { yieldable: true },
    );
    await flush();
    expect(gate.stats().active).toBe(0); // given back while waiting
    const block = deferred();
    const b = gate.run(async () => {
      order.push("b:run");
      await block.promise;
    });
    const c = gate.run(async () => {
      order.push("c:run");
    });
    await flush();
    expect(order).toEqual(["a:start", "b:run"]);
    other.resolve("x");
    await flush();
    expect(gate.stats().queued).toBe(2); // a (at the head) and c
    block.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a:start", "b:run", "a:resumed:x", "c:run"]);
    expect(gate.stats()).toEqual({ active: 0, queued: 0, max: 1 });
  });

  test("a rejected wait still takes the slot back before rethrowing", async () => {
    const gate = createSemaphore(1);
    const other = deferred();
    let activeAfter = -1;
    const a = gate.run(
      async () => {
        try {
          await whileWaiting(other.promise);
        } finally {
          activeAfter = gate.stats().active;
        }
      },
      { yieldable: true },
    );
    await flush();
    other.reject(new Error("boom"));
    expect(a).rejects.toThrow("boom");
    await flush();
    expect(activeAfter).toBe(1);
    expect(gate.stats().active).toBe(0);
  });

  test("overlapping waits give back once and take back once", async () => {
    const gate = createSemaphore(2);
    const x = deferred();
    const y = deferred();
    const a = gate.run(
      async () => {
        await Promise.all([whileWaiting(x.promise), whileWaiting(y.promise)]);
      },
      { yieldable: true },
    );
    await flush();
    expect(gate.stats().active).toBe(0);
    x.resolve();
    await flush();
    expect(gate.stats().active).toBe(0); // y still pending
    y.resolve();
    await a;
    expect(gate.stats()).toEqual({ active: 0, queued: 0, max: 2 });
  });

  test("a non-yieldable slot is held while its body waits", async () => {
    const gate = createSemaphore(1);
    const other = deferred();
    const a = gate.run(async () => {
      await whileWaiting(other.promise);
    });
    await flush();
    expect(gate.stats().active).toBe(1);
    other.resolve();
    await a;
  });

  test("a wait outside any slot is the very promise", () => {
    const p = Promise.resolve(1);
    expect(whileWaiting(p)).toBe(p);
  });

  test("a wait started after the body settled takes nothing", async () => {
    const gate = createSemaphore(1);
    const late = deferred();
    let stray: Promise<unknown> | undefined;
    await gate.run(
      async () => {
        // Detached work the body does not await.
        setTimeout(() => {
          stray = whileWaiting(late.promise);
        }, 0);
      },
      { yieldable: true },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.stats().active).toBe(0);
    late.resolve();
    await stray;
    expect(gate.stats()).toEqual({ active: 0, queued: 0, max: 1 });
  });
});

describe("nested yieldable slots", () => {
  test("only the innermost slot is given back; the outer stays held", async () => {
    const gate = createSemaphore(2);
    const other = deferred();
    let activeDuringWait = -1;
    const outer = gate.run(
      () =>
        gate.run(
          async () => {
            const wait = whileWaiting(other.promise);
            activeDuringWait = gate.stats().active;
            other.resolve();
            await wait;
          },
          { yieldable: true },
        ),
      { yieldable: true },
    );
    await outer;
    expect(activeDuringWait).toBe(1); // the outer slot, never both released
    expect(gate.stats()).toEqual({ active: 0, queued: 0, max: 2 });
  });
});
