import { describe, expect, test } from "bun:test";
import { defineObservationSink } from "./define-observation-sink";

/** Runs `fn` with queueMicrotask captured, returning the callbacks it queued. */
function withCapturedMicrotasks(fn: () => void): Array<() => void> {
  const queued: Array<() => void> = [];
  const original = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (cb) => {
    queued.push(cb);
  };
  try {
    fn();
  } finally {
    globalThis.queueMicrotask = original;
  }
  return queued;
}

describe("defineObservationSink", () => {
  test("fans each emit out to every subscriber", () => {
    const sink = defineObservationSink<number>();
    const a: number[] = [];
    const b: number[] = [];
    sink.subscribe((n) => a.push(n));
    sink.subscribe((n) => b.push(n));
    sink.emit(1);
    sink.emit(2);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  test("unsubscribe stops delivery to that subscriber only", () => {
    const sink = defineObservationSink<number>();
    const a: number[] = [];
    const b: number[] = [];
    const offA = sink.subscribe((n) => a.push(n));
    sink.subscribe((n) => b.push(n));
    sink.emit(1);
    offA();
    offA();
    sink.emit(2);
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  test("the same function subscribed twice is two subscriptions", () => {
    const sink = defineObservationSink<number>();
    const seen: number[] = [];
    const fn = (n: number) => seen.push(n);
    const off1 = sink.subscribe(fn);
    sink.subscribe(fn);
    sink.emit(1);
    off1();
    sink.emit(2);
    expect(seen).toEqual([1, 1, 2]);
  });

  test("hasSubscribers tracks the subscriber set", () => {
    const sink = defineObservationSink<number>();
    expect(sink.hasSubscribers()).toBe(false);
    const off = sink.subscribe(() => {});
    expect(sink.hasSubscribers()).toBe(true);
    off();
    expect(sink.hasSubscribers()).toBe(false);
  });

  test("an emit with no subscriber is dropped, not held for a later one", () => {
    const sink = defineObservationSink<number>();
    sink.emit(1);
    const seen: number[] = [];
    sink.subscribe((n) => seen.push(n));
    expect(seen).toEqual([]);
    sink.emit(2);
    expect(seen).toEqual([2]);
  });

  test("a throwing subscriber does not stop the others; its error is rethrown on a microtask", () => {
    const sink = defineObservationSink<number>();
    const boom = new Error("boom");
    const seen: number[] = [];
    sink.subscribe(() => {
      throw boom;
    });
    sink.subscribe((n) => seen.push(n));
    const queued = withCapturedMicrotasks(() => sink.emit(1));
    expect(seen).toEqual([1]);
    const [rethrow, ...rest] = queued;
    expect(rest).toHaveLength(0);
    expect(rethrow).toBeFunction();
    expect(() => rethrow?.()).toThrow(boom);
  });

  test("a subscriber added during an emit receives from the next emit", () => {
    const sink = defineObservationSink<number>();
    const late: number[] = [];
    let added = false;
    sink.subscribe(() => {
      if (added) return;
      added = true;
      sink.subscribe((n) => late.push(n));
    });
    sink.emit(1);
    sink.emit(2);
    expect(late).toEqual([2]);
  });
});
