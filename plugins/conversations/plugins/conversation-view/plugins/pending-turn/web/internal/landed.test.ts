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

const turn = (
  state: TurnState,
  submittedMs: number | null,
  promptUuid: string | null = null,
) => ({
  state,
  submittedAt: submittedMs === null ? null : new Date(T0 + submittedMs),
  promptUuid,
});

/** A transcript whose newest event was written `ms` after T0. */
const upTo = (ms: number) => [typed("x", ms)];

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
      expect(transcriptShows(turn(state, 500), upTo(499))).toBe(false);
      expect(transcriptShows(turn(state, 500), upTo(500))).toBe(true);
      expect(transcriptShows(turn(state, 500), [])).toBe(false);
    }
  });

  test("a confirmed turn whose message the transcript holds, whatever its time", () => {
    // A prompt folded into a running turn is written with its enqueue time,
    // before the confirmation.
    const folded: JsonlEvent = {
      kind: "user-text",
      at: at(100),
      text: "also this",
      uuid: "cmd-1",
    };
    expect(transcriptShows(turn("accepted", 500, "cmd-1"), [folded])).toBe(
      true,
    );
    expect(transcriptShows(turn("accepted", 500, "cmd-2"), [folded])).toBe(
      false,
    );
    expect(transcriptShows(turn("typed", null, "cmd-1"), [folded])).toBe(false);
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
      expect(transcriptShows(turn(state, null), upTo(1e9))).toBe(false);
    }
  });
});
