import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { TurnState } from "@plugins/conversations/plugins/turn-ledger/core";
import { transcriptShows } from "./landed";

const T0 = Date.parse("2026-10-18T15:53:08Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const line = (uuid: string, ms: number): JsonlEvent => ({
  kind: "user-text",
  at: at(ms),
  text: `text ${uuid}`,
  uuid,
});

const turn = (
  state: TurnState,
  submittedMs: number | null,
  promptUuid: string | null = "mine",
) => ({
  state,
  submittedAt: submittedMs === null ? null : new Date(T0 + submittedMs),
  promptUuid,
});

describe("transcriptShows", () => {
  test("a confirmed turn, once the window holds its own line", () => {
    const window = [line("before", 100), line("other", 900)];
    // Newer events are no sign of it: only its uuid is.
    expect(transcriptShows(turn("accepted", 500), window)).toBe(false);
    expect(
      transcriptShows(turn("accepted", 500), [...window, line("mine", 950)]),
    ).toBe(true);
  });

  test("a prompt folded into a running turn, by the message the parser makes of it", () => {
    // The CLI writes a folded prompt as a queued_command attachment; the
    // parser makes it the user's message under its source_uuid, at its
    // enqueue time — earlier than the confirmation.
    expect(
      transcriptShows(turn("accepted", 500), [
        line("before", 100),
        line("mine", 300),
      ]),
    ).toBe(true);
  });

  test("a confirmed turn whose line is above the window", () => {
    expect(transcriptShows(turn("accepted", 500), [line("later", 501)])).toBe(
      true,
    );
    expect(transcriptShows(turn("accepted", 500), [line("same", 500)])).toBe(
      false,
    );
  });

  test("an event turn, by the event card the parser makes of its line", () => {
    const event: JsonlEvent = {
      kind: "event-turn",
      at: at(600),
      text: "reported",
      uuid: "mine",
    };
    expect(
      transcriptShows(turn("accepted", 500), [line("before", 100), event]),
    ).toBe(true);
  });

  test("a send the CLI merged into another's line, by that line's merged uuids", () => {
    // Two event turns queued together, dequeued as one line under the first
    // send's uuid: the second has no line of its own.
    const merged: JsonlEvent = {
      kind: "event-turn",
      at: at(600),
      text: "two envelopes",
      uuid: "first",
      mergedSendUuids: ["mine"],
    };
    expect(
      transcriptShows(turn("accepted", 500), [line("before", 100), merged]),
    ).toBe(true);
  });

  test("never with no transcript loaded", () => {
    expect(transcriptShows(turn("accepted", 500), [])).toBe(false);
  });

  test("a row confirmed before uuids were recorded: the newest event at or after it (temporary)", () => {
    const legacy = turn("accepted", 500, null);
    expect(transcriptShows(legacy, [line("a", 100), line("b", 499)])).toBe(
      false,
    );
    expect(transcriptShows(legacy, [line("a", 100), line("b", 500)])).toBe(
      true,
    );
  });

  test("never a turn the agent has not confirmed, whatever the transcript holds", () => {
    const unconfirmed: TurnState[] = [
      "held",
      "typing",
      "typed",
      "failed",
      "returned",
      "withdrawn",
    ];
    for (const state of unconfirmed) {
      expect(
        transcriptShows(turn(state, null), [line("mine", 1e9), line("x", 2e9)]),
      ).toBe(false);
    }
  });
});
