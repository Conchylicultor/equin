import { describe, expect, test } from "bun:test";
import {
  drainRecordFor,
  heldPastSwitch,
  parseDrainRecord,
  parseUnserved,
  renderUnserved,
  type SlotHolder,
  type UnservedStamp,
} from "./layout";

const SWITCH = new Date("2026-11-20T05:18:53Z");
const stamp = (asleep: UnservedStamp["asleep"]): UnservedStamp => ({
  at: SWITCH.toISOString(),
  reportAfterMs: 10_000,
  asleep,
});
const holder: SlotHolder = {
  pid: 85950,
  kind: "exec-child",
  mode: "shared",
  acquiredAt: SWITCH.toISOString(),
  label: "type-check-backstop",
};
// report-1794976612-es42jy's last occurrence: 7 384 s on the wall clock.
const RELEASE = new Date(SWITCH.getTime() + 7_384_000);

describe("heldPastSwitch", () => {
  test("takes the machine's sleep inside the span out of it", () => {
    expect(
      heldPastSwitch(stamp({ boot: "b", asleepMs: 500 }), RELEASE, {
        boot: "b",
        asleepMs: 500 + 6_970_000,
      }),
    ).toEqual({
      heldPastSwitchMs: 7_384_000,
      sleptMs: 6_970_000,
      awakeMs: 414_000,
    });
  });

  test("is the wall clock where the sleep cannot be told", () => {
    const wall = {
      heldPastSwitchMs: 7_384_000,
      sleptMs: null,
      awakeMs: 7_384_000,
    };
    // An old stamp, no sleep clock now, or a reboot in between.
    expect(
      heldPastSwitch(stamp(null), RELEASE, { boot: "b", asleepMs: 9 }),
    ).toEqual(wall);
    expect(
      heldPastSwitch(stamp({ boot: "b", asleepMs: 0 }), RELEASE, null),
    ).toEqual(wall);
    expect(
      heldPastSwitch(stamp({ boot: "a", asleepMs: 0 }), RELEASE, {
        boot: "b",
        asleepMs: 9e9,
      }),
    ).toEqual(wall);
  });

  test("never counts more sleep than the span, nor less than none", () => {
    const now = new Date(SWITCH.getTime() + 1_000);
    expect(
      heldPastSwitch(stamp({ boot: "b", asleepMs: 0 }), now, {
        boot: "b",
        asleepMs: 5_000,
      }).awakeMs,
    ).toBe(0);
    expect(
      heldPastSwitch(stamp({ boot: "b", asleepMs: 10 }), now, {
        boot: "b",
        asleepMs: 9.9,
      }).sleptMs,
    ).toBe(0);
  });
});

describe("drainRecordFor", () => {
  const record = (asleepNow: { boot: string; asleepMs: number } | null) =>
    drainRecordFor({
      stamp: stamp({ boot: "b", asleepMs: 0 }),
      holder,
      slot: "/slot-3",
      commit: null,
      now: RELEASE,
      asleepNow,
    });

  test("a release whose span was all sleep but the threshold owes no record", () => {
    expect(record({ boot: "b", asleepMs: 7_380_000 })).toBeNull();
  });

  test("past the threshold awake, the record carries the wall span and the sleep in it", () => {
    const r = record({ boot: "b", asleepMs: 6_970_000 });
    expect([r?.heldPastSwitchMs, r?.sleptMs]).toEqual([7_384_000, 6_970_000]);
  });
});

describe("formats across versions", () => {
  test("a stamp and a drain record written before the sleep clock read as unknown sleep", () => {
    expect(
      parseUnserved(
        "f",
        JSON.stringify({ at: SWITCH.toISOString(), reportAfterMs: 1 }),
      ).asleep,
    ).toBeNull();
    expect(
      parseDrainRecord(
        "f",
        JSON.stringify({
          kind: "guard",
          label: null,
          pid: 1,
          heldPastSwitchMs: 1,
          thresholdMs: 1,
          slot: "/s",
          commit: null,
          releasedAt: RELEASE.toISOString(),
        }),
      ).sleptMs,
    ).toBeNull();
  });

  test("a stamp round-trips its sleep mark, and a malformed one is refused", () => {
    const s = stamp({ boot: "b", asleepMs: 12 });
    expect(parseUnserved("f", renderUnserved(s))).toEqual(s);
    expect(() =>
      parseUnserved(
        "f",
        JSON.stringify({
          at: SWITCH.toISOString(),
          reportAfterMs: 1,
          asleep: { boot: 1 },
        }),
      ),
    ).toThrow("malformed");
  });
});
