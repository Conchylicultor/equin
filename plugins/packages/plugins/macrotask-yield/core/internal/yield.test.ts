import { describe, expect, test } from "bun:test";
import { createTimeSlicer, createTurnQueue, yieldMacrotask } from "./yield";

/** Hold the thread, as a synchronous start-up or a blocking syscall does. */
function blockThread(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin: nothing else can run on this thread meanwhile
  }
}

/**
 * Three concurrent tasks, each waiting on `wait` and then holding the thread
 * 30 ms. Returns the events in order, with a 1 ms interval's ticks among them:
 * after a 30 ms hold the interval is overdue, so it fires the moment the loop
 * reaches its timers.
 */
async function race(wait: () => Promise<void>): Promise<string[]> {
  const events: string[] = [];
  const tick = setInterval(() => events.push("tick"), 1);
  try {
    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await wait();
        events.push(`start ${i}`);
        blockThread(30);
      }),
    );
  } finally {
    clearInterval(tick);
  }
  return events;
}

/** The events strictly between each consecutive pair of starts. */
function betweenStarts(events: string[]): string[][] {
  const at = events.flatMap((e, i) => (e.startsWith("start") ? [i] : []));
  expect(at.map((i) => events[i])).toEqual(["start 0", "start 1", "start 2"]);
  return at.slice(1).map((end, k) => events.slice(at[k]! + 1, end));
}

describe("yieldMacrotask", () => {
  test("resolves only after the microtask queue has drained", async () => {
    const order: string[] = [];
    const macro = yieldMacrotask().then(() => order.push("macrotask"));
    void Promise.resolve().then(() => order.push("microtask"));
    await macro;
    expect(order).toEqual(["microtask", "macrotask"]);
  });

  test("lets a callback queued before it run first", async () => {
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    await yieldMacrotask();
    expect(ran).toBe(true);
  });

  // The premise `createTurnQueue` exists for, pinned so a runtime that changes
  // it is noticed (the queue stays correct either way; its doc would not).
  test("callers that yield at the same moment resume back to back", async () => {
    for (const gap of betweenStarts(await race(yieldMacrotask))) {
      expect(gap).not.toContain("tick");
    }
  });
});

describe("createTurnQueue", () => {
  test("concurrent callers each resume on their own turn, timers running in between", async () => {
    const turns = createTurnQueue();
    for (const gap of betweenStarts(await race(turns))) {
      expect(gap).toContain("tick");
    }
  });

  test("a call made after the queue went idle still yields a full turn", async () => {
    const turns = createTurnQueue();
    await turns();
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    await turns();
    expect(ran).toBe(true);
  });
});

describe("createTimeSlicer", () => {
  test("resolves without yielding while the budget has not elapsed", async () => {
    const slice = createTimeSlicer(10_000);
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    await slice();
    expect(ran).toBe(false);
  });

  test("yields a macrotask once the budget has elapsed", async () => {
    const slice = createTimeSlicer(0);
    const start = performance.now();
    while (performance.now() - start < 2) {
      // burn past the budget
    }
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    await slice();
    expect(ran).toBe(true);
  });

  test("concurrent slicers sharing a turn queue each resume on their own turn", async () => {
    const turns = createTurnQueue();
    const slicers = [0, 1, 2].map(() => createTimeSlicer(0, turns));
    blockThread(2);
    let i = 0;
    for (const gap of betweenStarts(await race(() => slicers[i++]!()))) {
      expect(gap).toContain("tick");
    }
  });
});
