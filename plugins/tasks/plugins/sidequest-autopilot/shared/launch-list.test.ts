import { describe, expect, test } from "bun:test";
import { laneOf, launchListRows, preTicked } from "./launch-list";
import type { SidequestTriage } from "./triage";

const at = new Date("2026-10-01T00:00:00Z");
const read = (over: Partial<SidequestTriage> = {}): SidequestTriage => ({
  taskId: "a",
  verdict: "ready",
  context: "ctx",
  question: null,
  answers: [],
  answer: null,
  risk: "low",
  sizeMinutes: 30,
  value: 3,
  areas: [],
  mainSha: "abc",
  sourceTitle: "T",
  sourceDescription: "",
  triagedAt: at,
  ...over,
});
const fresh = { stale: false } as const;

describe("laneOf", () => {
  test("a person's decision wins over anything triage said", () => {
    expect(laneOf(read({ verdict: "obsolete" }), "approved")).toBe("approved");
    expect(laneOf(null, "excluded")).toBe("excluded");
  });

  test("untriaged, obsolete, an open question, otherwise proposed", () => {
    expect(laneOf(null, null)).toBe("triaging");
    expect(laneOf(read({ verdict: "obsolete" }), null)).toBe("obsolete");
    expect(
      laneOf(
        read({ verdict: "decide", question: "Q?", answers: ["A", "B"] }),
        null,
      ),
    ).toBe("needs-call");
    expect(
      laneOf(
        read({
          verdict: "decide",
          question: "Q?",
          answers: ["A", "B"],
          answer: "A",
        }),
        null,
      ),
    ).toBe("proposed");
    expect(laneOf(read({ verdict: "ready", risk: "high" }), null)).toBe(
      "proposed",
    );
  });
});

describe("preTicked", () => {
  test("ticks a fresh ready, low-risk read", () => {
    expect(preTicked(read(), fresh)).toBe(true);
  });

  test("never ticks a risky, stale or untriaged one", () => {
    expect(preTicked(read({ risk: "medium" }), fresh)).toBe(false);
    expect(preTicked(read(), { stale: true, reason: "old" })).toBe(false);
    expect(preTicked(null, null)).toBe(false);
  });

  test("ticks a question only once the person answered it", () => {
    const q = { verdict: "decide" as const, question: "Q?", answers: ["A"] };
    expect(preTicked(read(q), fresh)).toBe(false);
    expect(preTicked(read({ ...q, answer: "A" }), fresh)).toBe(true);
  });
});

describe("launchListRows", () => {
  const task = (id: string, days: number) => ({
    id,
    title: "T",
    description: null,
    createdAt: new Date(at.getTime() + days * 86_400_000),
  });

  test("ranks by value for size, untriaged after, oldest first on ties", () => {
    const rows = launchListRows(
      [task("old", 0), task("new", 1), task("best", 2), task("untriaged", -5)],
      new Map([
        ["old", read({ taskId: "old" })],
        ["new", read({ taskId: "new" })],
        ["best", read({ taskId: "best", value: 5 })],
      ]),
      new Map(),
      at,
      7,
    );
    expect(rows.map((r) => [r.task.id, r.rank])).toEqual([
      ["best", 1],
      ["old", 2],
      ["new", 3],
      ["untriaged", 4],
    ]);
  });

  test("an approval is the person's, whatever triage pre-ticked", () => {
    const [row] = launchListRows(
      [task("a", 0)],
      new Map([["a", read()]]),
      new Map(),
      at,
      7,
    );
    expect(row?.preTicked).toBe(true);
    expect(row?.lane).toBe("proposed");
    expect(row?.decision).toBeNull();
  });
});
