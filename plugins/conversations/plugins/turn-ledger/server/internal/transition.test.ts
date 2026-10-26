import { describe, expect, test } from "bun:test";
import { TurnStateSchema, type TurnState } from "../../core/schemas";
import {
  promptIs,
  transitionTurn,
  type TurnEvent,
  type TurnFacts,
  type TurnTransition,
} from "./transition";

const STATES = TurnStateSchema.options;
const TYPED = "fix the build";
const AT = new Date("2026-10-18T15:53:10Z");
const PROMPT_UUID = "5b1f6a1e-0000-4000-8000-000000000001";

const EVENTS = {
  hold: { kind: "hold" },
  deliver: { kind: "deliver", typedText: TYPED },
  release: { kind: "release", typedText: TYPED },
  typed: { kind: "typed" },
  failed: { kind: "failed", error: "agent exploded" },
  confirmed: { kind: "confirmed", promptUuid: PROMPT_UUID, at: AT },
  // The temporary id-less path: a pre-turn-id agent's launch prompt.
  "confirmed-equal": {
    kind: "confirmed-by-text",
    prompt: TYPED,
    promptUuid: PROMPT_UUID,
    at: AT,
  },
  "confirmed-other": {
    kind: "confirmed-by-text",
    prompt: `stale draft\n${TYPED}`,
    promptUuid: PROMPT_UUID,
    at: AT,
  },
  dropped: { kind: "dropped" },
  returned: { kind: "returned" },
  withdraw: { kind: "withdraw" },
} as const satisfies Record<string, TurnEvent>;

type EventName = keyof typeof EVENTS;

const NOTHING: Record<EventName, null> = {
  hold: null,
  deliver: null,
  release: null,
  typed: null,
  failed: null,
  confirmed: null,
  "confirmed-equal": null,
  "confirmed-other": null,
  dropped: null,
  returned: null,
  withdraw: null,
};

// The whole machine, written out: for every state, where each event takes it
// (null = no change). A new state or event that is not added here fails the
// coverage test below, so the table cannot silently fall behind the code.
const MATRIX: Record<TurnState, Record<EventName, TurnState | null>> = {
  held: {
    ...NOTHING,
    deliver: "typing",
    failed: "failed",
    confirmed: "accepted",
    "confirmed-equal": "accepted",
    returned: "returned",
  },
  typing: {
    ...NOTHING,
    hold: "held",
    release: "held",
    typed: "typed",
    failed: "failed",
    confirmed: "accepted",
    "confirmed-equal": "accepted",
  },
  typed: {
    ...NOTHING,
    confirmed: "accepted",
    "confirmed-equal": "accepted",
    dropped: "failed",
    returned: "returned",
  },
  accepted: { ...NOTHING, returned: "returned" },
  returned: NOTHING,
  failed: {
    ...NOTHING,
    deliver: "typing",
    confirmed: "accepted",
    "confirmed-equal": "accepted",
    withdraw: "withdrawn",
  },
  // The truth wins: the agent took it after all.
  withdrawn: {
    ...NOTHING,
    confirmed: "accepted",
    "confirmed-equal": "accepted",
  },
};

const row = (state: TurnState): TurnFacts => ({
  state,
  typedText: TYPED,
});

describe("transitionTurn", () => {
  test("the matrix covers every state and event", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...STATES].sort());
  });

  for (const state of STATES) {
    for (const name of Object.keys(EVENTS) as EventName[]) {
      const expected = MATRIX[state][name];
      test(`${state} + ${name} → ${expected ?? "no change"}`, () => {
        expect(transitionTurn(row(state), EVENTS[name])?.state ?? null).toBe(
          expected,
        );
      });
    }
  }

  test("every event reaches a fixed point: applying it again changes nothing", () => {
    for (const state of STATES) {
      for (const event of Object.values(EVENTS)) {
        const first = transitionTurn(row(state), event);
        if (!first) continue;
        const again = transitionTurn(
          {
            state: first.state,
            typedText: first.patch.typedText ?? TYPED,
          },
          event,
        );
        // `hold` / `release` and `deliver` are inverses, never self-loops.
        expect(again?.state ?? first.state).toBe(first.state);
      }
    }
  });

  test("the confirmation and the submit check converge in either order", () => {
    const confirmedFirst = transitionTurn(row("typing"), EVENTS.confirmed)!;
    expect(transitionTurn(row(confirmedFirst.state), EVENTS.typed)).toBeNull();
    expect(transitionTurn(row(confirmedFirst.state), EVENTS.failed)).toBeNull();
    const typedFirst = transitionTurn(row("typing"), EVENTS.typed)!;
    expect(transitionTurn(row(typedFirst.state), EVENTS.confirmed)?.state).toBe(
      confirmedFirst.state,
    );
  });

  test("a confirmation by id records when, and as which transcript line, whatever the text", () => {
    const expected: TurnTransition = {
      state: "accepted",
      patch: { submittedAt: AT, promptUuid: PROMPT_UUID, error: null },
    };
    expect(transitionTurn(row("typed"), EVENTS.confirmed)).toEqual(expected);
    // The text plays no part: the id names the row.
    expect(
      transitionTurn({ state: "typed", typedText: "" }, EVENTS.confirmed),
    ).toEqual(expected);
  });

  test("a confirmation by id takes a withdrawn or a held turn: the agent has it", () => {
    expect(transitionTurn(row("withdrawn"), EVENTS.confirmed)?.state).toBe(
      "accepted",
    );
    expect(transitionTurn(row("held"), EVENTS.confirmed)?.state).toBe(
      "accepted",
    );
  });

  test("a confirmation by id leaves a settled turn as it is", () => {
    for (const state of ["accepted", "returned"] as const) {
      expect(transitionTurn(row(state), EVENTS.confirmed)).toBeNull();
    }
  });

  test("withdrawing keeps the error, for history", () => {
    expect(transitionTurn(row("failed"), EVENTS.withdraw)).toEqual({
      state: "withdrawn",
      patch: {},
    });
  });

  test("an id-less confirmation of the same text records when the agent took it", () => {
    expect(
      transitionTurn(row("typed"), EVENTS["confirmed-equal"])?.patch,
    ).toEqual({
      submittedAt: AT,
      promptUuid: PROMPT_UUID,
      error: null,
    });
  });

  test("a retry clears the old error and types the given text", () => {
    expect(
      transitionTurn(
        { state: "failed", typedText: "old" },
        { kind: "deliver", typedText: "new" },
      ),
    ).toEqual({ state: "typing", patch: { typedText: "new", error: null } });
  });
});

describe("promptIs (temporary: a pre-turn-id agent's launch prompt)", () => {
  test("equal, byte for byte", () => {
    const text = "line one\n> quoted\n@/a/b.png";
    expect(promptIs(text, text)).toBe(true);
  });

  test("edge whitespace is not a difference", () => {
    expect(promptIs(" /todo blocks", "/todo blocks")).toBe(true);
  });

  test("a prompt that merely contains the turn is not it", () => {
    expect(promptIs("old draft new turn", "new turn")).toBe(false);
  });

  test("unrelated text, or nothing typed, is not it", () => {
    expect(promptIs("hello", "goodbye")).toBe(false);
    expect(promptIs("  ", "  ")).toBe(false);
  });
});
