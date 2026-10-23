import { describe, expect, test } from "bun:test";
import { TurnStateSchema, type TurnState } from "../../core/schemas";
import {
  matchPrompt,
  promptCandidates,
  transitionTurn,
  type TurnEvent,
  type TurnFacts,
} from "./transition";

const STATES = TurnStateSchema.options;
const TYPED = "fix the build";
const AT = new Date("2026-10-18T15:53:10Z");

const EVENTS = {
  hold: { kind: "hold" },
  deliver: { kind: "deliver", typedText: TYPED },
  release: { kind: "release", typedText: TYPED },
  typed: { kind: "typed" },
  unverified: { kind: "unverified", reason: "box kept text" },
  failed: { kind: "failed", error: "agent exploded" },
  "confirmed-equal": { kind: "confirmed", prompt: TYPED, at: AT },
  "confirmed-merged": {
    kind: "confirmed",
    prompt: `stale draft\n${TYPED}`,
    at: AT,
  },
  "confirmed-other": {
    kind: "confirmed",
    prompt: "something the user typed",
    at: AT,
  },
  returned: { kind: "returned" },
  withdraw: { kind: "withdraw" },
} as const satisfies Record<string, TurnEvent>;

type EventName = keyof typeof EVENTS;

// The whole machine, written out: for every state, where each event takes it
// (null = no change). A new state or event that is not added here fails the
// coverage test below, so the table cannot silently fall behind the code.
const MATRIX: Record<TurnState, Record<EventName, TurnState | null>> = {
  held: {
    hold: null,
    deliver: "typing",
    release: null,
    typed: null,
    unverified: null,
    failed: "failed",
    "confirmed-equal": null,
    "confirmed-merged": null,
    "confirmed-other": null,
    returned: "returned",
    withdraw: null,
  },
  typing: {
    hold: "held",
    deliver: null,
    release: "held",
    typed: "typed",
    unverified: "unverified",
    failed: "failed",
    "confirmed-equal": "accepted",
    "confirmed-merged": "merged",
    "confirmed-other": null,
    returned: null,
    withdraw: null,
  },
  typed: {
    hold: null,
    deliver: null,
    release: null,
    typed: null,
    unverified: null,
    failed: null,
    "confirmed-equal": "accepted",
    "confirmed-merged": "merged",
    "confirmed-other": null,
    returned: "returned",
    withdraw: null,
  },
  accepted: {
    hold: null,
    deliver: null,
    release: null,
    typed: null,
    unverified: null,
    failed: null,
    "confirmed-equal": null,
    "confirmed-merged": null,
    "confirmed-other": null,
    returned: "returned",
    withdraw: null,
  },
  merged: {
    hold: null,
    deliver: null,
    release: null,
    typed: null,
    unverified: null,
    failed: null,
    "confirmed-equal": null,
    "confirmed-merged": null,
    "confirmed-other": null,
    returned: "returned",
    withdraw: null,
  },
  returned: {
    hold: null,
    deliver: null,
    release: null,
    typed: null,
    unverified: null,
    failed: null,
    "confirmed-equal": null,
    "confirmed-merged": null,
    "confirmed-other": null,
    returned: null,
    withdraw: null,
  },
  failed: {
    hold: null,
    deliver: "typing",
    release: null,
    typed: null,
    unverified: null,
    failed: null,
    "confirmed-equal": "accepted",
    "confirmed-merged": "merged",
    "confirmed-other": null,
    returned: null,
    withdraw: "withdrawn",
  },
  unverified: {
    hold: null,
    deliver: "typing",
    release: null,
    typed: null,
    unverified: null,
    failed: null,
    "confirmed-equal": "accepted",
    "confirmed-merged": "merged",
    "confirmed-other": null,
    returned: null,
    withdraw: "withdrawn",
  },
  withdrawn: {
    hold: null,
    deliver: null,
    release: null,
    typed: null,
    unverified: null,
    failed: null,
    // The truth wins, but only exactly.
    "confirmed-equal": "accepted",
    "confirmed-merged": null,
    "confirmed-other": null,
    returned: null,
    withdraw: null,
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
    const confirmedFirst = transitionTurn(
      row("typing"),
      EVENTS["confirmed-equal"],
    )!;
    expect(transitionTurn(row(confirmedFirst.state), EVENTS.typed)).toBeNull();
    expect(
      transitionTurn(row(confirmedFirst.state), EVENTS.unverified),
    ).toBeNull();
    const typedFirst = transitionTurn(row("typing"), EVENTS.typed)!;
    expect(
      transitionTurn(row(typedFirst.state), EVENTS["confirmed-equal"])?.state,
    ).toBe(confirmedFirst.state);
  });

  test("withdrawing keeps the error, for history", () => {
    expect(transitionTurn(row("unverified"), EVENTS.withdraw)).toEqual({
      state: "withdrawn",
      patch: {},
    });
  });

  test("a merge records the other text the CLI submitted", () => {
    expect(
      transitionTurn(row("typed"), EVENTS["confirmed-merged"])?.patch,
    ).toEqual({
      submittedText: `stale draft\n${TYPED}`,
      submittedAt: AT,
      extraText: "stale draft",
      error: null,
    });
  });

  test("an accept records when the CLI submitted it", () => {
    expect(
      transitionTurn(row("typed"), EVENTS["confirmed-equal"])?.patch,
    ).toEqual({
      submittedAt: AT,
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

describe("matchPrompt", () => {
  test("equal, byte for byte", () => {
    expect(
      matchPrompt(
        "line one\n> quoted\n@/a/b.png",
        "line one\n> quoted\n@/a/b.png",
      ),
    ).toEqual({
      kind: "equal",
    });
  });

  test("edge whitespace is not a difference (the launch message's escape)", () => {
    expect(matchPrompt(" /todo blocks", "/todo blocks")).toEqual({
      kind: "equal",
    });
  });

  test("contains: the extra text around the turn", () => {
    expect(matchPrompt("old draft new turn", "new turn")).toEqual({
      kind: "contains",
      extraText: "old draft",
    });
    expect(matchPrompt("before\nnew turn\nafter", "new turn")).toEqual({
      kind: "contains",
      extraText: "before\nafter",
    });
  });

  test("none: unrelated text, or nothing typed", () => {
    expect(matchPrompt("hello", "goodbye")).toEqual({ kind: "none" });
    expect(matchPrompt("hello", "  ")).toEqual({ kind: "none" });
  });
});

describe("promptCandidates", () => {
  const at = (id: string, state: TurnState, typedText: string) => ({
    id,
    state,
    typedText,
  });

  test("a withdrawn turn is tried last, and only for an exact match", () => {
    const rows = [
      at("withdrawn", "withdrawn", "fix"),
      at("cli-returned", "returned", "fix"),
      at("fresh", "typed", "fix"),
    ];
    expect(promptCandidates("fix", rows).map((r) => r.id)).toEqual([
      "fresh",
      "withdrawn",
    ]);
    expect(promptCandidates("please fix", rows).map((r) => r.id)).toEqual([
      "fresh",
    ]);
  });

  test("equal matches come before merges, each oldest first", () => {
    const rows = [
      at("old-merge", "typed", "fix"),
      at("equal", "typed", "please fix it"),
      at("new-merge", "unverified", "please"),
    ];
    expect(promptCandidates("please fix it", rows).map((r) => r.id)).toEqual([
      "equal",
      "old-merge",
      "new-merge",
    ]);
  });

  test("a failed row matches only exactly: it never reached the box to be merged", () => {
    const rows = [at("failed", "failed", "fix")];
    expect(promptCandidates("please fix it", rows)).toEqual([]);
    expect(promptCandidates("fix", rows).map((r) => r.id)).toEqual(["failed"]);
  });

  test("settled and held rows are never candidates", () => {
    const rows = [
      at("accepted", "accepted", "fix"),
      at("returned", "returned", "fix"),
      at("held", "held", "fix"),
    ];
    expect(promptCandidates("fix", rows)).toEqual([]);
  });
});
