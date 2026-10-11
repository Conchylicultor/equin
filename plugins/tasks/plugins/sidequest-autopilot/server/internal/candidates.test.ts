import { describe, expect, test } from "bun:test";
import {
  NO_CONTEXT,
  NO_DECISION,
  NO_DESCRIPTION,
  sidequestCandidates,
} from "./candidates";

const task = (
  id: string,
  description: string | null,
  title = `Task ${id}`,
) => ({
  id,
  title,
  description,
  createdAt: new Date("2026-10-01T00:00:00Z"),
});
const read = (value: number, sizeMinutes: number, extra = {}) => ({
  context: `ctx ${value}`,
  question: null,
  answer: null,
  value,
  sizeMinutes,
  ...extra,
});
const none = new Map();

describe("sidequestCandidates", () => {
  test("keeps the order it is given (oldest first) when none is triaged", () => {
    expect(
      sidequestCandidates([task("a", "x"), task("b", "y")], none).map(
        (c) => c.taskId,
      ),
    ).toEqual(["a", "b"]);
  });

  test("ranks by triage's value for size, untriaged last", () => {
    const triage = new Map([
      ["a", read(1, 120)],
      ["c", read(5, 30)],
    ]);
    expect(
      sidequestCandidates(
        [task("a", "x"), task("b", "y"), task("c", "z")],
        triage,
      ).map((c) => c.taskId),
    ).toEqual(["c", "a", "b"]);
  });

  test("fills the template's variables from the task and its triage", () => {
    expect(
      sidequestCandidates(
        [task("a", "  It breaks.  ")],
        new Map([
          ["a", read(3, 30, { question: "Amber or grey?", answer: "Amber" })],
        ]),
      )[0]?.variables,
    ).toEqual({
      taskId: "a",
      title: "Task a",
      description: "It breaks.",
      context: "ctx 3",
      decision: "Asked: Amber or grey?\nThe person answered: Amber",
    });
  });

  test("an untriaged or unanswered task says so rather than leaving a hole", () => {
    const [untriaged] = sidequestCandidates([task("a", "x")], none);
    expect(untriaged?.variables.context).toBe(NO_CONTEXT);
    expect(untriaged?.variables.decision).toBe(NO_DECISION);
    const [unanswered] = sidequestCandidates(
      [task("a", "x")],
      new Map([["a", read(3, 30, { question: "Amber or grey?" })]]),
    );
    expect(unanswered?.variables.decision).toBe(NO_DECISION);
  });

  test("a task without a description says so rather than leaving a hole", () => {
    expect(
      sidequestCandidates([task("a", null)], none)[0]?.variables.description,
    ).toBe(NO_DESCRIPTION);
    expect(
      sidequestCandidates([task("a", "   ")], none)[0]?.variables.description,
    ).toBe(NO_DESCRIPTION);
  });

  test("an empty title reads as Untitled", () => {
    expect(
      sidequestCandidates([task("a", "x", " ")], none)[0]?.variables.title,
    ).toBe("Untitled");
  });
});
