import { describe, expect, test } from "bun:test";
import type {
  TriageRead,
  TriageReadResult,
} from "@plugins/tasks/plugins/task-triage/core";
import {
  NO_CONTEXT,
  NO_DECISION,
  NO_DESCRIPTION,
  NO_NOTE,
  sidequestCandidates,
} from "./candidates";

const at = new Date("2026-10-01T00:00:00Z");
const task = (
  id: string,
  description: string | null,
  title = `Task ${id}`,
  days = 0,
) => ({
  id,
  title,
  description,
  createdAt: new Date(at.getTime() + days * 86_400_000),
});
const result = (over: Partial<TriageReadResult> = {}): TriageReadResult => ({
  verdict: "ready",
  priority: "could",
  taskType: "bugfix",
  risk: "low",
  context: "ctx",
  question: null,
  answers: [],
  areas: [],
  triagedAt: at,
  mainSha: "abc",
  answer: null,
  ...over,
});
const done = (
  taskId: string,
  over: Partial<TriageReadResult> = {},
): TriageRead => ({
  taskId,
  conversationId: null,
  runTaskId: null,
  requestedAt: at,
  state: "done",
  read: result(over),
});
const none = new Map<string, TriageRead>();
const noNotes = new Map<string, string>();

describe("sidequestCandidates", () => {
  test("oldest first when none is triaged", () => {
    expect(
      sidequestCandidates(
        [task("b", "y", "B", 1), task("a", "x", "A", 0)],
        none,
        noNotes,
      ).map((c) => c.taskId),
    ).toEqual(["a", "b"]);
  });

  test("ranks by priority (must → could), untriaged last", () => {
    const triage = new Map([
      ["a", done("a", { priority: "could" })],
      ["c", done("c", { priority: "must" })],
    ]);
    expect(
      sidequestCandidates(
        [task("a", "x"), task("b", "y"), task("c", "z")],
        triage,
        noNotes,
      ).map((c) => c.taskId),
    ).toEqual(["c", "a", "b"]);
  });

  test("a run in flight ranks by the read it would replace", () => {
    const triage = new Map<string, TriageRead>([
      ["a", done("a", { priority: "could" })],
      [
        "b",
        {
          taskId: "b",
          conversationId: null,
          runTaskId: null,
          requestedAt: at,
          state: "running",
          startedAt: at,
          previous: result({ priority: "must" }),
        },
      ],
    ]);
    expect(
      sidequestCandidates(
        [task("a", "x"), task("b", "y")],
        triage,
        noNotes,
      ).map((c) => c.taskId),
    ).toEqual(["b", "a"]);
  });

  test("fills the template's variables from the task, its triage and its note", () => {
    expect(
      sidequestCandidates(
        [task("a", "  It breaks.  ")],
        new Map([
          [
            "a",
            done("a", {
              context: "ctx 3",
              question: "Amber or grey?",
              answers: ["Amber", "Grey"],
              answer: "Amber",
            }),
          ],
        ]),
        new Map([["a", "  Keep it small.  "]]),
      )[0]?.variables,
    ).toEqual({
      taskId: "a",
      title: "Task a",
      description: "It breaks.",
      context: "ctx 3",
      decision: "Asked: Amber or grey?\nThe person answered: Amber",
      note: "Keep it small.",
    });
  });

  test("an untriaged or unanswered task says so rather than leaving a hole", () => {
    const [untriaged] = sidequestCandidates([task("a", "x")], none, noNotes);
    expect(untriaged?.variables.context).toBe(NO_CONTEXT);
    expect(untriaged?.variables.decision).toBe(NO_DECISION);
    expect(untriaged?.variables.note).toBe(NO_NOTE);
    const [unanswered] = sidequestCandidates(
      [task("a", "x")],
      new Map([["a", done("a", { question: "Amber or grey?" })]]),
      noNotes,
    );
    expect(unanswered?.variables.decision).toBe(NO_DECISION);
  });

  test("a task without a description says so rather than leaving a hole", () => {
    expect(
      sidequestCandidates([task("a", null)], none, noNotes)[0]?.variables
        .description,
    ).toBe(NO_DESCRIPTION);
    expect(
      sidequestCandidates([task("a", "   ")], none, noNotes)[0]?.variables
        .description,
    ).toBe(NO_DESCRIPTION);
  });

  test("an empty title reads as Untitled", () => {
    expect(
      sidequestCandidates([task("a", "x", " ")], none, noNotes)[0]?.variables
        .title,
    ).toBe("Untitled");
  });
});
