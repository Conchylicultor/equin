import { describe, expect, test } from "bun:test";
import type {
  TriageRead,
  TriageReadResult,
} from "@plugins/tasks/plugins/task-triage/core";
import { laneOf, launchListRows, preTicked } from "./launch-list";

const at = new Date("2026-10-01T00:00:00Z");
const result = (over: Partial<TriageReadResult> = {}): TriageReadResult => ({
  verdict: "ready",
  priority: "should",
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
const base = (taskId: string) => ({
  taskId,
  conversationId: null,
  runTaskId: null,
  requestedAt: at,
});
const done = (
  over: Partial<TriageReadResult> = {},
  taskId = "a",
): TriageRead => ({ ...base(taskId), state: "done", read: result(over) });
const stale = (over: Partial<TriageReadResult> = {}): TriageRead => ({
  ...base("a"),
  state: "stale",
  staleReason: "old",
  read: result(over),
});
const queued = (previous: TriageReadResult | null = null): TriageRead => ({
  ...base("a"),
  state: "queued",
  startedAt: null,
  previous,
});
const failed = (previous: TriageReadResult | null = null): TriageRead => ({
  ...base("a"),
  state: "failed",
  error: "boom",
  previous,
});

describe("laneOf", () => {
  test("a person's decision wins over anything triage said", () => {
    expect(laneOf(done({ verdict: "obsolete" }), "approved")).toBe("approved");
    expect(laneOf(null, "excluded")).toBe("excluded");
  });

  test("not read yet — never asked, queued or running — is triaging", () => {
    expect(laneOf(null, null)).toBe("triaging");
    expect(laneOf(queued(), null)).toBe("triaging");
  });

  test("a failed first run is its own lane; a failed re-run keeps its read", () => {
    expect(laneOf(failed(), null)).toBe("failed");
    expect(laneOf(failed(result()), null)).toBe("proposed");
    expect(laneOf(queued(result({ verdict: "obsolete" })), null)).toBe(
      "obsolete",
    );
  });

  test("obsolete or won't, an open question, otherwise proposed", () => {
    expect(laneOf(done({ verdict: "obsolete" }), null)).toBe("obsolete");
    expect(laneOf(done({ priority: "wont" }), null)).toBe("obsolete");
    expect(
      laneOf(
        done({ verdict: "decide", question: "Q?", answers: ["A", "B"] }),
        null,
      ),
    ).toBe("needs-call");
    expect(
      laneOf(
        done({
          verdict: "decide",
          question: "Q?",
          answers: ["A", "B"],
          answer: "A",
        }),
        null,
      ),
    ).toBe("proposed");
    expect(laneOf(done({ risk: "high" }), null)).toBe("proposed");
  });
});

describe("preTicked", () => {
  test("ticks a fresh ready, low-risk must or should", () => {
    expect(preTicked(done({ priority: "must" }))).toBe(true);
    expect(preTicked(done({ priority: "should" }))).toBe(true);
  });

  test("never ticks a could, a risky, stale, in-flight or untriaged one", () => {
    expect(preTicked(done({ priority: "could" }))).toBe(false);
    expect(preTicked(done({ risk: "medium" }))).toBe(false);
    expect(preTicked(done({ verdict: "split" }))).toBe(false);
    expect(preTicked(stale())).toBe(false);
    expect(preTicked(queued(result()))).toBe(false);
    expect(preTicked(null)).toBe(false);
  });

  test("ticks a question only once the person answered it", () => {
    const q = { verdict: "decide" as const, question: "Q?", answers: ["A"] };
    expect(preTicked(done(q))).toBe(false);
    expect(preTicked(done({ ...q, answer: "A" }))).toBe(true);
  });
});

describe("launchListRows", () => {
  const task = (id: string, days: number) => ({
    id,
    title: "T",
    createdAt: new Date(at.getTime() + days * 86_400_000),
  });

  test("ranks by priority, untriaged after, oldest first on ties", () => {
    const rows = launchListRows(
      [
        task("old", 0),
        task("new", 1),
        task("must", 2),
        task("wont", -9),
        task("untriaged", -5),
      ],
      new Map([
        ["old", done({}, "old")],
        ["new", done({}, "new")],
        ["must", done({ priority: "must" }, "must")],
        ["wont", done({ priority: "wont" }, "wont")],
      ]),
      new Map(),
    );
    expect(rows.map((r) => [r.task.id, r.rank])).toEqual([
      ["must", 1],
      ["old", 2],
      ["new", 3],
      ["wont", 4],
      ["untriaged", 5],
    ]);
  });

  test("an approval is the person's, whatever triage pre-ticked", () => {
    const [row] = launchListRows(
      [task("a", 0)],
      new Map([["a", done()]]),
      new Map(),
    );
    expect(row?.preTicked).toBe(true);
    expect(row?.lane).toBe("proposed");
    expect(row?.decision).toBeNull();
  });
});
