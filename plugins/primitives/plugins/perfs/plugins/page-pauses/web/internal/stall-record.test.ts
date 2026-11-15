import { describe, expect, test } from "bun:test";
import { createStallRecord } from "./stall-record";

/** Whether `p` has settled by the end of the current microtask queue. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe("createStallRecord", () => {
  test("a stall's entry arriving late is still there when the wait resolves", async () => {
    // The 2026-11-15 incident: an update ends at t=1000, behind a 1102 ms frame
    // ending at 900 whose entry has not reached the page yet.
    let now = 1250;
    const r = createStallRecord({ minMs: 1000, cap: 10, now: () => now });
    const known = r.knownThrough(1000);
    expect(await settled(known)).toBe(false);
    // The stall's entry, then a later frame's: the record now holds every
    // frame that ended by 1000.
    r.noteFrame(-202, 1102);
    expect(await settled(known)).toBe(false);
    now = 1400;
    r.noteFrame(1300, 60);
    expect(await settled(known)).toBe(true);
    expect(r.stalls).toEqual([{ startMs: -202, endMs: 900 }]);
  });

  test("a later frame already seen: known at once", async () => {
    const r = createStallRecord({ minMs: 1000, cap: 10, now: () => 2000 });
    r.noteFrame(1500, 80);
    expect(await settled(r.knownThrough(1200))).toBe(true);
  });

  test("a calm page with no later frame resolves after the grace, not before", async () => {
    const r = createStallRecord({
      minMs: 1000,
      cap: 10,
      graceMs: 30,
      now: () => Date.now(),
    });
    const end = Date.now();
    const known = r.knownThrough(end);
    expect(await settled(known)).toBe(false);
    await known;
    expect(Date.now() - end).toBeGreaterThanOrEqual(25);
  });

  test("past its grace: known at once", async () => {
    const r = createStallRecord({
      minMs: 1000,
      cap: 10,
      graceMs: 2000,
      now: () => 10_000,
    });
    expect(await settled(r.knownThrough(7000))).toBe(true);
  });

  test("short frames prove completeness but are no stalls", () => {
    const r = createStallRecord({ minMs: 1000, cap: 10, now: () => 0 });
    r.noteFrame(0, 999);
    r.noteFrame(1000, 1000);
    expect(r.stalls).toEqual([{ startMs: 1000, endMs: 2000 }]);
  });
});
