import { expect, test } from "bun:test";
import type { AwakeClockReading } from "@plugins/packages/plugins/sleep-clock/core";
import { armAwakeDeadline } from "./awake-deadline";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a timer that fired after sleep re-arms for the awake budget left", async () => {
  // The awake clock advances only 5 ms per read: the timer's 20 ms passed
  // mostly "asleep", so the first firing is a wake-up call, not the deadline.
  let awake = 0;
  const reads: AwakeClockReading[] = [];
  const read = (): AwakeClockReading => {
    const r = { supported: true as const, awakeMs: awake };
    awake += 5;
    reads.push(r);
    return r;
  };
  let expired = false;
  armAwakeDeadline(20, () => (expired = true), read);
  await settle(30);
  expect(expired).toBe(false);
  await settle(80);
  expect(expired).toBe(true);
  // start, then a read per firing until 20 awake ms were spent.
  expect(reads.map((r) => (r.supported ? r.awakeMs : -1))).toEqual([
    0, 5, 10, 15, 20,
  ]);
});

test("an awake window as long as the budget expires on the first firing", async () => {
  let awake = 0;
  const read = (): AwakeClockReading => ({ supported: true, awakeMs: awake });
  let expired = false;
  armAwakeDeadline(10, () => (expired = true), read);
  awake = 10;
  await settle(30);
  expect(expired).toBe(true);
});

test("without an awake clock it is the plain timer", async () => {
  let expired = false;
  armAwakeDeadline(
    10,
    () => (expired = true),
    () => ({ supported: false }),
  );
  await settle(30);
  expect(expired).toBe(true);
});

test("cancel stops it", async () => {
  let expired = false;
  const cancel = armAwakeDeadline(10, () => (expired = true));
  cancel();
  await settle(30);
  expect(expired).toBe(false);
});
