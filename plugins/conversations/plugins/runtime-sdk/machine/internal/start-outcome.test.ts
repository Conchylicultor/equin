import { describe, expect, test } from "bun:test";
import { startOutcome } from "./start-outcome";

describe("startOutcome", () => {
  test("no answer is a slow start, whatever the projection says", () => {
    expect(
      startOutcome({ applied: true, agentSeq: null, cursorSeq: 3 }),
    ).toEqual({ kind: "slow" });
    expect(
      startOutcome({ applied: false, agentSeq: null, cursorSeq: 0 }),
    ).toEqual({ kind: "slow" });
  });

  test("an applied start is ready even when the agent has written more since", () => {
    expect(startOutcome({ applied: true, agentSeq: 9, cursorSeq: 2 })).toEqual({
      kind: "ready",
    });
  });

  test("an answer past an unapplied cursor is the consumer behind", () => {
    // The 2026-10-25 incident: the agent up and writing, the row at 0.
    expect(
      startOutcome({ applied: false, agentSeq: 870, cursorSeq: 0 }),
    ).toEqual({
      kind: "consumer-behind",
      cursorSeq: 0,
      agentSeq: 870,
    });
  });

  test("an answer the cursor already covers is ready", () => {
    expect(startOutcome({ applied: false, agentSeq: 4, cursorSeq: 4 })).toEqual(
      { kind: "ready" },
    );
  });
});
