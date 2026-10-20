import { describe, expect, test } from "bun:test";
import type { SleepClockReading } from "@plugins/packages/plugins/sleep-clock/core";
import { createSleepPublisher, sleepNowChanged } from "./sleep-publisher";

const BOOT = "B25F1FC6-798F-412D-B0DA-B41350248582";

function harness(first: SleepClockReading) {
  let reading = first;
  let notified = 0;
  const p = createSleepPublisher(() => reading);
  p.subscribe(() => notified++);
  return {
    p,
    set: (r: SleepClockReading) => (reading = r),
    notified: () => notified,
  };
}

describe("createSleepPublisher", () => {
  test("publishes the first reading, then only when it changes", () => {
    const h = harness({
      supported: true,
      boot: BOOT,
      asleepMs: 1000,
      wakeAtMs: 5,
    });
    h.p.publish();
    expect(h.notified()).toBe(1);
    expect(h.p.current()).toEqual({ boot: BOOT, asleepMs: 1000, wakeAtMs: 5 });

    // Same reading (modulo sub-ms read jitter): no push.
    h.set({ supported: true, boot: BOOT, asleepMs: 1000.0004, wakeAtMs: 5 });
    h.p.publish();
    h.p.publish();
    expect(h.notified()).toBe(1);
    expect(h.p.current()?.asleepMs).toBe(1000);

    // A wake: more sleep and a new waketime.
    h.set({ supported: true, boot: BOOT, asleepMs: 61_000, wakeAtMs: 90_000 });
    h.p.publish();
    expect(h.notified()).toBe(2);
    expect(h.p.current()).toEqual({
      boot: BOOT,
      asleepMs: 61_000,
      wakeAtMs: 90_000,
    });
  });

  test("current() before any publish reads the clock without pushing", () => {
    const h = harness({ supported: false });
    expect(h.p.current()).toBeNull();
    expect(h.notified()).toBe(0);
    // The loader's read counts as the baseline: an unchanged publish is silent.
    h.p.publish();
    expect(h.notified()).toBe(0);
  });

  test("an unsubscribed listener hears nothing more", () => {
    const h = harness({
      supported: true,
      boot: BOOT,
      asleepMs: 0,
      wakeAtMs: 1,
    });
    let other = 0;
    const stop = h.p.subscribe(() => other++);
    h.p.publish();
    expect(other).toBe(1);
    stop();
    h.set({ supported: true, boot: BOOT, asleepMs: 5_000, wakeAtMs: 2 });
    h.p.publish();
    expect(other).toBe(1);
    expect(h.notified()).toBe(2);
  });
});

describe("sleepNowChanged", () => {
  const base = { boot: BOOT, asleepMs: 10, wakeAtMs: null };
  test("unsupported vs supported", () => {
    expect(sleepNowChanged(null, null)).toBe(false);
    expect(sleepNowChanged(null, base)).toBe(true);
    expect(sleepNowChanged(base, null)).toBe(true);
  });
  test("a new boot, a new wake, or a millisecond more sleep", () => {
    expect(sleepNowChanged(base, { ...base, boot: "other" })).toBe(true);
    expect(sleepNowChanged(base, { ...base, wakeAtMs: 1 })).toBe(true);
    expect(sleepNowChanged(base, { ...base, asleepMs: 11 })).toBe(true);
    expect(sleepNowChanged(base, { ...base, asleepMs: 10.5 })).toBe(false);
  });
});
