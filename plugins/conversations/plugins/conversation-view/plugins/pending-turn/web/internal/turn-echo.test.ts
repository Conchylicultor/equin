import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  turnIdKind,
  type TurnState,
} from "@plugins/conversations/plugins/turn-ledger/core";
import { turnEchoSamples } from "./turn-echo";

const T0 = Date.parse("2026-11-09T00:47:18Z");
const line = (uuid: string, ms: number): JsonlEvent => ({
  kind: "user-text",
  at: new Date(T0 + ms).toISOString(),
  text: `text ${uuid}`,
  uuid,
});
const row = (state: TurnState, submittedMs: number | null) => ({
  id: turnIdKind.mint(),
  kind: "turn" as const,
  state,
  submittedAt: submittedMs === null ? null : new Date(T0 + submittedMs),
  promptUuid: "mine",
});

describe("turnEchoSamples", () => {
  test("a taken turn seen waiting is sampled when its line lands", () => {
    const r = row("accepted", 0);
    const before = [line("older", -5000)];
    const first = turnEchoSamples("conv-1", new Map(), [r], before, T0 + 100);
    expect(first.samples).toEqual([]);
    expect([...first.waiting.keys()]).toEqual([r.id]);

    // The incident: written 12 ms after it was taken, shown a minute later.
    const after = [...before, line("mine", 12)];
    const second = turnEchoSamples(
      "conv-1",
      first.waiting,
      [r],
      after,
      T0 + 60_000,
    );
    expect(second.waiting.size).toBe(0);
    expect(second.samples).toEqual([
      {
        signal: "turn-echo",
        key: "jsonl-events",
        params: { id: "conv-1" },
        variant: "turn",
        phases: { "agent-write": 12, delivery: 59_988 },
        totalMs: 60_000,
      },
    ]);
  });

  test("a turn already shown at the first look, or not taken yet, says nothing", () => {
    const shown = row("accepted", 0);
    const typed = row("typed", null);
    const events = [line("mine", 12)];
    const out = turnEchoSamples(
      "conv-1",
      new Map(),
      [shown, typed],
      events,
      T0 + 1000,
    );
    expect(out.samples).toEqual([]);
    expect(out.waiting.size).toBe(0);
  });
});
