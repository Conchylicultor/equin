import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  turnIdKind,
  type TurnState,
} from "@plugins/conversations/plugins/turn-ledger/core";
import { ownMsOf } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
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
        phases: { "agent-write": 12, compaction: 0, delivery: 59_988 },
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

  // Replay of report-1794916751-fib0co's 2026-11-21 00:25 sample
  // (conv-1795201743-fo945q, an idle agent: taken 30 ms after the send):
  // `/compact` taken at 00:25:35.246, its compaction boundary written at
  // 00:26:36.806, on screen at 00:26:37.568 — 62.3 s, filed as a slow echo.
  test("a /compact turn's compaction is its own phase, off the echo's own time", () => {
    const taken = Date.parse("2026-11-21T00:25:35.246Z");
    const r = { ...row("accepted", taken - T0), promptUuid: "compact-cmd" };
    const before = [line("older", -5000)];
    const first = turnEchoSamples("conv-1", new Map(), [r], before, taken + 50);
    const compaction: JsonlEvent = {
      kind: "compaction",
      at: "2026-11-21T00:26:36.806Z",
      files: [],
      requestUuid: "compact-cmd",
    };
    const { samples } = turnEchoSamples(
      "conv-1",
      first.waiting,
      [r],
      [...before, compaction],
      Date.parse("2026-11-21T00:26:37.568Z"),
    );
    expect(samples).toHaveLength(1);
    const sample = samples[0]!;
    expect(sample.phases).toEqual({
      "agent-write": 0,
      compaction: 61_560,
      delivery: 762,
    });
    expect(sample.totalMs).toBe(62_322);
    expect(ownMsOf(sample)).toBe(762);
  });

  // A real slow echo to an idle agent stays its own time: the line written
  // late (agent-write) or delivered late (delivery) is still judged in full.
  test("a plain turn slow to be written or delivered keeps all of it as own time", () => {
    const r = row("accepted", 0);
    const before = [line("older", -5000)];
    const first = turnEchoSamples("conv-1", new Map(), [r], before, T0 + 10);
    const { samples } = turnEchoSamples(
      "conv-1",
      first.waiting,
      [r],
      [...before, line("mine", 4_000)],
      T0 + 9_000,
    );
    expect(samples[0]!.phases).toEqual({
      "agent-write": 4_000,
      compaction: 0,
      delivery: 5_000,
    });
    expect(ownMsOf(samples[0]!)).toBe(9_000);
  });
});
