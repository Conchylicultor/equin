import { describe, expect, test } from "bun:test";
import type { RelayQuestion } from "../../core/schemas";
import { replyOf } from "@plugins/conversations/plugins/transcript-source/core";
import { toCliAnswer } from "./answer";

const COLOR: RelayQuestion = {
  question: "Which colour?",
  header: "Colour",
  options: [
    { label: "Blue", description: "" },
    { label: "Red", description: "" },
  ],
  multiSelect: false,
};
const VEG: RelayQuestion = {
  question: "Which vegetables?",
  header: "Veg",
  options: [
    { label: "Leek", description: "" },
    { label: "Corn", description: "" },
  ],
  multiSelect: true,
};
const QUESTIONS = [COLOR, VEG];
const sel = (selected: string[], other: string | null = null) => ({
  selected,
  other,
});

describe("toCliAnswer", () => {
  test("labels map to the tool's answer strings; multi-select joins with ', '", () => {
    expect(
      toCliAnswer(QUESTIONS, {
        selections: {
          "Which colour?": sel(["Blue"]),
          "Which vegetables?": sel(["Leek", "Corn"]),
        },
      }),
    ).toEqual({
      ok: true,
      answer: {
        answers: { "Which colour?": "Blue", "Which vegetables?": "Leek, Corn" },
      },
    });
  });

  test("free text is accepted as the answer, and added to a multi-select", () => {
    expect(
      toCliAnswer(QUESTIONS, {
        selections: {
          "Which colour?": sel([], "  Teal "),
          "Which vegetables?": sel(["Leek"], "Kale"),
        },
      }),
    ).toEqual({
      ok: true,
      answer: {
        answers: { "Which colour?": "Teal", "Which vegetables?": "Leek, Kale" },
      },
    });
  });

  test("an empty multi-select answers with the CLI's no-selection sentinel", () => {
    const r = toCliAnswer(QUESTIONS, {
      selections: {
        "Which colour?": sel(["Red"]),
        "Which vegetables?": sel([]),
      },
    });
    expect(r.ok && r.answer.answers["Which vegetables?"]).toBe(
      "(no option selected)",
    );
  });

  test("an unknown question is refused", () => {
    expect(
      toCliAnswer(QUESTIONS, {
        selections: {
          "Which colour?": sel(["Blue"]),
          "Which vegetables?": sel([]),
          "Which planet?": sel([]),
        },
      }),
    ).toEqual({ ok: false, error: "unknown question: Which planet?" });
  });

  test("an unknown label is refused (free text goes in `other`)", () => {
    expect(
      toCliAnswer(QUESTIONS, {
        selections: {
          "Which colour?": sel(["Green"]),
          "Which vegetables?": sel([]),
        },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('"Green"') });
  });

  test("a single-select takes exactly one answer", () => {
    for (const s of [sel([]), sel(["Blue", "Red"]), sel(["Blue"], "Teal")]) {
      expect(
        toCliAnswer(QUESTIONS, {
          selections: { "Which colour?": s, "Which vegetables?": sel([]) },
        }).ok,
      ).toBe(false);
    }
  });

  test("every question needs an answer unless a response stands in", () => {
    expect(
      toCliAnswer(QUESTIONS, {
        selections: { "Which colour?": sel(["Blue"]) },
      }),
    ).toEqual({ ok: false, error: "unanswered question: Which vegetables?" });
    expect(
      toCliAnswer(QUESTIONS, { selections: {}, response: "Skip these" }),
    ).toEqual({ ok: true, answer: { answers: {}, response: "Skip these" } });
  });

  test("a reply beside picks carries the picks, which the CLI would drop", () => {
    const r = toCliAnswer(QUESTIONS, {
      selections: { "Which colour?": sel(["Blue"]) },
      response: "Why ask?",
    });
    expect(r).toEqual({
      ok: true,
      answer: {
        answers: { "Which colour?": "Blue" },
        response: 'My answers: "Which colour?"="Blue"\n\nWhy ask?',
      },
    });
    expect(r.ok && replyOf(r.answer)).toBe("Why ask?");
  });

  test("notes ride as annotations, on known questions only", () => {
    const selections = {
      "Which colour?": sel(["Blue"]),
      "Which vegetables?": sel([]),
    };
    expect(
      toCliAnswer(QUESTIONS, {
        selections,
        annotations: { "Which colour?": { notes: "darker" } },
      }),
    ).toMatchObject({
      ok: true,
      answer: { annotations: { "Which colour?": { notes: "darker" } } },
    });
    expect(
      toCliAnswer(QUESTIONS, {
        selections,
        annotations: { "Nope?": { notes: "x" } },
      }).ok,
    ).toBe(false);
  });
});
