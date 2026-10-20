import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type {
  LedgerTurn,
  TurnId,
  TurnState,
} from "@plugins/conversations/plugins/turn-ledger/core";
import { landedTurnIds, promptLandings } from "./landed";

const T0 = Date.parse("2026-10-18T15:53:08Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function row(
  id: string,
  sentMs: number,
  state: TurnState = "accepted",
  over: Partial<LedgerTurn> = {},
): LedgerTurn {
  return {
    id: id as TurnId,
    conversationId: "c",
    kind: "turn",
    text: id,
    state,
    extraText: null,
    error: null,
    createdAt: new Date(T0 + sentMs),
    updatedAt: new Date(T0 + sentMs),
    ...over,
  };
}

const typed = (text: string, ms: number): JsonlEvent => ({
  kind: "user-text",
  at: at(ms),
  text,
  uuid: `u-${text}-${ms}`,
});
const queue = (
  operation: string,
  ms: number,
  content?: string,
): JsonlEvent => ({ kind: "queue-operation", at: at(ms), operation, content });

describe("promptLandings", () => {
  test("a typed prompt lands as its user row; a relayed user line does not", () => {
    expect(
      promptLandings([
        typed("go", 900),
        { kind: "user-text", at: at(950), text: "report remainder" },
      ]),
    ).toEqual([T0 + 900]);
  });

  test("a busy agent's queued prompt lands at its enqueue, once", () => {
    // Injected into the running turn: enqueue, then remove — no user row.
    expect(
      promptLandings([
        queue("enqueue", 100, "then push"),
        queue("remove", 200, "then push"),
      ]),
    ).toEqual([T0 + 100]);
    // Dequeued at the turn's end: its own user row follows — the same prompt.
    expect(
      promptLandings([
        queue("enqueue", 100, "then push"),
        queue("dequeue", 300),
        typed("then push", 310),
      ]),
    ).toEqual([T0 + 100]);
  });
});

describe("landedTurnIds", () => {
  test("nothing in the transcript yet: nothing landed", () => {
    expect(landedTurnIds([row("t1", 0)], [])).toEqual(new Set());
  });

  test("the k-th turn on its way is the k-th prompt landing after the oldest", () => {
    const rows = [row("t2", 2_000), row("t1", 0)];
    const before = typed("older turn", -5_000);
    expect(landedTurnIds(rows, [before, typed("t1", 900)])).toEqual(
      new Set(["t1"]),
    );
    expect(
      landedTurnIds(rows, [before, typed("t1", 900), typed("t2", 2_500)]),
    ).toEqual(new Set(["t1", "t2"]));
  });

  test("turns that do not land as a prompt are never matched nor counted", () => {
    const rows = [
      row("answer", 0, "accepted", { kind: "answer" }),
      row("slash", 100, "typed", { text: "/compact" }),
      row("cut", 200, "returned"),
      row("t1", 300),
    ];
    expect(landedTurnIds(rows, [typed("t1", 900)])).toEqual(new Set(["t1"]));
  });
});
