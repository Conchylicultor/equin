import { describe, expect, test } from "bun:test";
import { withDeadline } from "./deadline";

// The regression these pin: browser-fetch's `await import("playwright")` used to
// be awaited with no deadline, so a module load that never settled parked a
// caller forever — observed in a live backend as a refresh job open for hours
// with no error, no log line and no failed run.

class SlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlowError";
  }
}

describe("withDeadline", () => {
  test("passes a value through when the work wins the race", async () => {
    const value = await withDeadline(
      Promise.resolve("loaded"),
      1_000,
      () => new Error("should not fire"),
    );
    expect(value).toBe("loaded");
  });

  test("rejects with the caller's error when the work never settles", async () => {
    // A promise with no resolver — the shape of the wedged import, exactly.
    const never = new Promise<string>(() => {});
    const caught = await withDeadline(
      never,
      10,
      () => new SlowError("took too long"),
    ).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(SlowError);
    expect((caught as Error).message).toBe("took too long");
  });

  test("rejects with the work's OWN error, not the deadline's, when the work fails first", async () => {
    // A failed import must stay distinguishable from a slow one: the caller
    // clears its memo for one and keeps it for the other.
    const boom = new Error("Cannot find module 'playwright'");
    const caught = await withDeadline(
      Promise.reject(boom),
      1_000,
      () => new Error("deadline"),
    ).catch((err: unknown) => err);
    expect(caught).toBe(boom);
  });

  test("clears its timer on success, so a fast win leaves nothing pending", async () => {
    // A leaked timer would hold the event loop open for the rest of the budget.
    // Proven by elapsed time: with the timer still armed, an await of a later,
    // shorter tick could not complete before the (huge) budget.
    const startedAt = performance.now();
    await withDeadline(Promise.resolve(1), 60_000, () => new Error("deadline"));
    await new Promise((r) => setTimeout(r, 5));
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
