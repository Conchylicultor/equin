import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { answerTriageEndpoint, setTriageNoteEndpoint } from "./endpoints";

function only(
  endpoint: { effect: Parameters<typeof readLiveEffect>[0] },
  body: unknown,
) {
  const [t, ...rest] = readLiveEffect(endpoint.effect).resolve({
    params: { taskId: "task-1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row" || rest.length > 0) {
    throw new Error("expected exactly one row target");
  }
  return t;
}

describe("answerTriageEndpoint effect", () => {
  test("patches the answer onto the triage row, compared", () => {
    const t = only(answerTriageEndpoint, { answer: "Pointer" });
    expect(t.subject).toBe("collection:task-triage.reads");
    expect(t.set).toEqual({ answer: "Pointer" });
    expect(t.enters).toBe(false);
    expect(t.apply({ taskId: "task-1", answer: null, state: "done" })).toEqual({
      taskId: "task-1",
      answer: "Pointer",
      state: "done",
    });
  });

  test("null clears it; a row not held predicts nothing", () => {
    const t = only(answerTriageEndpoint, { answer: null });
    expect(t.set).toEqual({ answer: null });
    expect(t.apply(undefined)).toBeUndefined();
  });
});

describe("setTriageNoteEndpoint effect", () => {
  test("text upserts the note row", () => {
    const t = only(setTriageNoteEndpoint, { note: "start in the player" });
    expect(t.subject).toBe("collection:task-triage.notes");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ note: "start in the player" });
    expect(t.apply(undefined)).toEqual({
      taskId: "task-1",
      note: "start in the player",
    });
  });

  test("blank deletes it, as the server does", () => {
    const t = only(setTriageNoteEndpoint, { note: "  \n" });
    expect(t.removes).toBe(true);
  });
});
