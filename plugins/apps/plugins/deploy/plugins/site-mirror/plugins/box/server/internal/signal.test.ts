import { describe, expect, test } from "bun:test";
import { createKeyedThrottle, type ThrottleClock } from "./signal";

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 0;
  const clock: ThrottleClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    },
    pending: () => timers.length,
  };
}

describe("createKeyedThrottle", () => {
  test("a quiet key fires at once; a burst folds into one trailing fire", () => {
    const c = fakeClock();
    const fired: [string, number][] = [];
    const th = createKeyedThrottle(
      2_000,
      (k) => fired.push([k, c.clock.now()]),
      c.clock,
    );
    th.ring("a");
    c.advance(100);
    th.ring("a");
    th.ring("a");
    c.advance(500);
    th.ring("a");
    expect(fired).toEqual([["a", 0]]);
    c.advance(1_400);
    expect(fired).toEqual([
      ["a", 0],
      ["a", 2_000],
    ]);
  });

  test("keys are throttled apart", () => {
    const c = fakeClock();
    const fired: string[] = [];
    const th = createKeyedThrottle(2_000, (k) => fired.push(k), c.clock);
    th.ring("a");
    th.ring("b");
    expect(fired).toEqual(["a", "b"]);
  });

  test("a ring after the interval fires at once", () => {
    const c = fakeClock();
    const fired: number[] = [];
    const th = createKeyedThrottle(
      2_000,
      () => fired.push(c.clock.now()),
      c.clock,
    );
    th.ring("a");
    c.advance(2_500);
    th.ring("a");
    expect(fired).toEqual([0, 2_500]);
  });

  test("dispose cancels a pending trailing fire", () => {
    const c = fakeClock();
    const fired: number[] = [];
    const th = createKeyedThrottle(
      2_000,
      () => fired.push(c.clock.now()),
      c.clock,
    );
    th.ring("a");
    th.ring("a");
    expect(c.pending()).toBe(1);
    th.dispose();
    c.advance(5_000);
    expect(fired).toEqual([0]);
  });
});
