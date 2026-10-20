import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { TurnState } from "@plugins/conversations/plugins/turn-ledger/core";
import { transcriptReachedAt, transcriptShows } from "./landed";

const T0 = Date.parse("2026-10-18T15:53:08Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const typed = (text: string, ms: number): JsonlEvent => ({
  kind: "user-text",
  at: at(ms),
  text,
  uuid: `u-${text}-${ms}`,
});

const turn = (state: TurnState, submittedMs: number | null) => ({
  state,
  submittedAt: submittedMs === null ? null : new Date(T0 + submittedMs),
});

describe("transcriptReachedAt", () => {
  test("is the newest event's time, or null for an empty transcript", () => {
    expect(transcriptReachedAt([])).toBeNull();
    expect(transcriptReachedAt([typed("a", 100), typed("b", 900)])).toBe(
      T0 + 900,
    );
  });
});

describe("transcriptShows", () => {
  test("a confirmed turn, once the transcript reaches its confirmation", () => {
    for (const state of ["accepted", "merged"] as const) {
      expect(transcriptShows(turn(state, 500), T0 + 499)).toBe(false);
      expect(transcriptShows(turn(state, 500), T0 + 500)).toBe(true);
      expect(transcriptShows(turn(state, 500), null)).toBe(false);
    }
  });

  test("never a turn the agent has not confirmed, however far the transcript goes", () => {
    const unconfirmed: TurnState[] = [
      "held",
      "typing",
      "typed",
      "failed",
      "unverified",
      "returned",
      "withdrawn",
    ];
    for (const state of unconfirmed) {
      expect(transcriptShows(turn(state, null), T0 + 1e9)).toBe(false);
    }
  });
});
