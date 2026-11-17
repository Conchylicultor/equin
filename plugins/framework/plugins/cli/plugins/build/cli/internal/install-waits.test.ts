import { describe, expect, test } from "bun:test";
import type { OpRecord } from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import {
  HOLDER_QUIET_MS,
  STALL_WAIT_MS,
  judgeHolder,
  stallWords,
} from "./install-waits";

const T0 = Date.parse("2026-11-17T12:00:00Z");
const MIN = 60_000;

/** A running op that got the build slot at T0 and last made progress `quietAt` ms after. */
function holder(quietAt: number, outcome = "running"): OpRecord {
  return {
    opId: "op-48211",
    kind: "test",
    pid: 48211,
    requestedAt: new Date(T0).toISOString(),
    grantedAt: new Date(T0).toISOString(),
    steps: [{ name: "run", startMs: 0, durationMs: quietAt }],
    outcome,
  } as unknown as OpRecord;
}

describe("the install's stall rule (the build slot's holder stopped making progress)", () => {
  test("not before the install has waited STALL_WAIT_MS, even on a long-quiet holder", () => {
    const waitStart = T0 + 3 * 60 * MIN;
    const verdict = judgeHolder(holder(9 * MIN), waitStart, waitStart + MIN);
    expect(verdict).toEqual({
      stuck: false,
      recheckAt: waitStart + STALL_WAIT_MS,
    });
    expect(
      judgeHolder(holder(9 * MIN), waitStart, waitStart + STALL_WAIT_MS),
    ).toEqual({
      stuck: true,
      quietSince: T0 + 9 * MIN,
    });
  });

  test("a holder still moving is not stuck: the next look is when it would have been quiet long enough", () => {
    const waitStart = T0 + 20 * MIN;
    const verdict = judgeHolder(
      holder(19 * MIN),
      waitStart,
      waitStart + STALL_WAIT_MS,
    );
    expect(verdict).toEqual({
      stuck: false,
      recheckAt: T0 + 19 * MIN + HOLDER_QUIET_MS,
    });
  });

  test("a holder that finished is never a stall", () => {
    expect(judgeHolder(holder(0, "success"), T0, T0 + 60 * MIN)).toEqual({
      stuck: false,
      recheckAt: null,
    });
    expect(judgeHolder(undefined, T0, T0 + 60 * MIN)).toEqual({
      stuck: false,
      recheckAt: null,
    });
  });

  test("its words: no internal names in the message, the op in the evidence, one event's size", () => {
    const words = stallWords(holder(9 * MIN), T0 + 9 * MIN, T0 + 3 * 60 * MIN);
    expect(words.text).toContain("A test started 3 hours ago");
    expect(words.text).not.toMatch(/op-|grant|pid/);
    expect(words.evidence[0]).toContain("op-48211");
    expect(
      Buffer.byteLength(
        JSON.stringify({
          v: 1,
          t: "2026-11-17T12:00:00Z",
          type: "pause",
          step: "build.interface",
          kind: "stall",
          ...words,
          blocking: false,
          optional: false,
          manual: null,
        }),
      ),
    ).toBeLessThan(512);
  });
});
