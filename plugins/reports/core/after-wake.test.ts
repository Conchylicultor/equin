import { describe, expect, test } from "bun:test";
import { afterWakeSummary, formatAfterWake } from "./after-wake";

const WOKE = Date.UTC(2026, 10, 14, 16, 23, 58);
const wake = { wokeAt: WOKE, sleptMs: 268_000 };

describe("formatAfterWake", () => {
  test("how long after which sleep", () => {
    expect(formatAfterWake({ at: WOKE + 400, afterWake: wake })).toBe(
      "400ms after the machine woke from 4m 28s asleep",
    );
    expect(formatAfterWake({ at: WOKE, afterWake: null })).toBeNull();
  });
});

describe("afterWakeSummary", () => {
  test("nothing to say when no occurrence followed a wake", () => {
    expect(afterWakeSummary([])).toBeNull();
    expect(afterWakeSummary([{ at: 1, afterWake: null }])).toBeNull();
  });

  test("says how many, and the latest", () => {
    const one = afterWakeSummary([{ at: WOKE + 400, afterWake: wake }]);
    expect(one).toStartWith(
      "Its occurrence came just after the machine woke from sleep (latest: 400ms after the machine woke from 4m 28s asleep, woke 2026-11-14T16:23:58.000Z).",
    );
    expect(
      afterWakeSummary([
        { at: WOKE + 900, afterWake: wake },
        { at: WOKE - 60_000, afterWake: null },
      ]),
    ).toStartWith("1 of the 2 kept occurrences");
    expect(
      afterWakeSummary([
        { at: WOKE + 900, afterWake: wake },
        { at: WOKE + 100, afterWake: wake },
      ]),
    ).toStartWith("All 2 kept occurrences");
  });
});
