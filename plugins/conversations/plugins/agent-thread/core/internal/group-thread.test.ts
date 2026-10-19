import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { defineThreadResult } from "./result";
import { groupThread } from "./group-thread";
import { latestResultOf, threadProgressOf, threadStateOf } from "./progress";

// Shaped like a real scratch-profile transcript: harness context before the
// first prompt, MCP tools under their transcript name, text blocks between
// tool calls.

const picks = defineThreadResult({
  tool: "places_show_picks",
  schema: z.object({
    picks: z.array(z.object({ googlePlaceId: z.string(), why: z.string() })),
  }),
});

const summary = defineThreadResult({
  tool: "places_summary",
  schema: z.object({ text: z.string() }),
});

let clock = Date.parse("2026-10-19T09:00:00Z");
function at(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

let ids = 0;
function call(
  name: string,
  input: unknown,
  result?: { content: string; isError?: boolean },
): JsonlEvent {
  const when = at();
  return {
    kind: "tool-call",
    at: when,
    messageId: `msg_${ids}`,
    toolUseId: `toolu_${++ids}`,
    name,
    input,
    ...(result ? { result: { at: when, ...result } } : {}),
  };
}

const user = (text: string): JsonlEvent => ({
  kind: "user-text",
  at: at(),
  text,
  uuid: `u-${++ids}`,
});
const say = (text: string): JsonlEvent => ({
  kind: "assistant-text",
  at: at(),
  text,
});

const harness: JsonlEvent[] = [
  { kind: "system", at: at(), subtype: "init", text: "Session started" },
  { kind: "preprompt", at: at(), text: "You find places." },
  call("Read", { file_path: "/w/CLAUDE.md" }, { content: "# Places" }),
];

const PICKS_INPUT = {
  picks: [
    { googlePlaceId: "ChIJ1", why: "Open Tuesdays until 11" },
    { googlePlaceId: "ChIJ2", why: "Hand-pulled noodles" },
  ],
};

const searchTurn: JsonlEvent[] = [
  user("chinese restaurant open tuesday"),
  say("Let me search around the map."),
  call(
    "mcp__equin__places_search_text",
    { query: "chinese restaurant" },
    { content: "12 places" },
  ),
  call(
    "mcp__equin__places_details",
    { ids: ["ChIJ1", "ChIJ2"] },
    { content: "…" },
  ),
  call("mcp__equin__places_show_picks", PICKS_INPUT, { content: "Shown" }),
  say("Here are two picks open on Tuesday."),
];

const IDLE = { status: "waiting", waitingFor: null } as const;
const WORKING = { status: "working", waitingFor: null } as const;
const GONE = { status: "gone", waitingFor: null } as const;

describe("groupThread", () => {
  test("opens a turn at each user-text and drops the harness context before it", () => {
    const turns = groupThread([...harness, ...searchTurn], [picks], IDLE);
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn!.user.text).toBe("chinese restaurant open tuesday");
    expect(turn!.steps.map((s) => s.event.name)).toEqual([
      "mcp__equin__places_search_text",
      "mcp__equin__places_details",
    ]);
    expect(turn!.steps.map((s) => s.state)).toEqual(["done", "done"]);
    expect(turn!.answer?.text).toBe("Here are two picks open on Tuesday.");
    expect(turn!.state).toBe("done");
  });

  test("an accepted result-tool call is a typed result, not a step", () => {
    const [turn] = groupThread(searchTurn, [picks], IDLE);
    expect(turn!.results).toHaveLength(1);
    const result = turn!.results[0]!;
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.def).toBe(picks);
    expect(result.payload.picks.map((p) => p.googlePlaceId)).toEqual([
      "ChIJ1",
      "ChIJ2",
    ]);
  });

  test("a refused result call stays a red step, and only accepted calls count", () => {
    const events = [
      user("cheaper"),
      call(
        "mcp__equin__places_show_picks",
        { picks: "oops" },
        { content: "Invalid input", isError: true },
      ),
      call("mcp__equin__places_show_picks", PICKS_INPUT, { content: "Shown" }),
    ];
    const [turn] = groupThread(events, [picks], IDLE);
    expect(turn!.steps.map((s) => s.state)).toEqual(["error"]);
    expect(turn!.results).toHaveLength(1);
    // No answer, but a result: the turn delivered.
    expect(turn!.state).toBe("done");
  });

  test("a later call of the same kind replaces the earlier one, at its own position", () => {
    const events = [
      user("cheaper"),
      call("mcp__equin__places_show_picks", PICKS_INPUT, { content: "ok" }),
      call(
        "mcp__equin__places_summary",
        { text: "two picks" },
        { content: "ok" },
      ),
      call(
        "mcp__equin__places_show_picks",
        { picks: [{ googlePlaceId: "ChIJ9", why: "Cheapest" }] },
        { content: "ok" },
      ),
    ];
    const [turn] = groupThread(events, [picks, summary], IDLE);
    expect(turn!.results.map((r) => r.def.tool)).toEqual([
      "places_summary",
      "places_show_picks",
    ]);
    const last = turn!.results[1]!;
    expect(last.kind).toBe("accepted");
    if (last.kind !== "accepted") throw new Error("unreachable");
    expect(last.payload).toEqual({
      picks: [{ googlePlaceId: "ChIJ9", why: "Cheapest" }],
    });
  });

  test("an accepted call whose input no longer parses is an invalid result", () => {
    const events = [
      user("q"),
      call(
        "mcp__equin__places_show_picks",
        { picks: [{ id: 1 }] },
        { content: "ok" },
      ),
    ];
    const [turn] = groupThread(events, [picks], IDLE);
    expect(turn!.results[0]!.kind).toBe("invalid");
  });

  test("only the newest turn runs while the conversation works", () => {
    const events = [
      ...searchTurn,
      user("cheaper"),
      call("mcp__equin__places_search_text", { query: "cheap chinese" }),
    ];
    const turns = groupThread(events, [picks], WORKING);
    expect(turns.map((t) => t.state)).toEqual(["done", "running"]);
    expect(turns[1]!.steps[0]!.state).toBe("running");
  });

  test("a conversation that ended mid-turn fails the turn and its unreturned step", () => {
    const events = [
      user("q"),
      call("mcp__equin__places_search_text", { query: "x" }),
    ];
    const [turn] = groupThread(events, [picks], GONE);
    expect(turn!.state).toBe("failed");
    expect(turn!.steps[0]!.state).toBe("error");
  });

  test("a turn blocked on a question is still running", () => {
    const events = [user("q"), call("AskUserQuestion", { questions: [] })];
    const [turn] = groupThread(events, [picks], {
      status: "waiting",
      waitingFor: "question",
    });
    expect(turn!.state).toBe("running");
  });

  test("blank assistant text is not an answer", () => {
    const [turn] = groupThread([user("q"), say("  \n")], [], IDLE);
    expect(turn!.answer).toBeNull();
    expect(turn!.state).toBe("failed");
  });

  test("a result kind listed twice is a mistake", () => {
    expect(() => groupThread([], [picks, picks], IDLE)).toThrow(/twice/);
  });
});

describe("defineThreadResult", () => {
  test("refuses a transcript name", () => {
    expect(() =>
      defineThreadResult({ tool: "mcp__equin__x", schema: z.object({}) }),
    ).toThrow(/own name/);
  });
});

describe("threadProgressOf", () => {
  test("reports the running step and the steps done so far", () => {
    const events = [
      user("q"),
      call("WebSearch", { query: "a" }, { content: "r" }),
      call("WebFetch", { url: "https://x.test" }),
    ];
    const turns = groupThread(events, [picks], WORKING);
    const progress = threadProgressOf(turns, {
      ...WORKING,
      lastViewedAt: null,
    });
    expect(progress.state).toBe("working");
    expect(progress.stepsDone).toBe(1);
    expect(progress.currentStep?.name).toBe("WebFetch");
    expect(progress.resultCount).toBe(0);
    expect(progress.unseen).toBe(false);
  });

  test("an answer after the last view is unseen; one before it is not", () => {
    const turns = groupThread(searchTurn, [picks], IDLE);
    const answeredAt = Date.parse(turns[0]!.answer!.at);
    const before = threadProgressOf(turns, {
      ...IDLE,
      lastViewedAt: new Date(answeredAt - 1),
    });
    const after = threadProgressOf(turns, {
      ...IDLE,
      lastViewedAt: new Date(answeredAt + 1),
    });
    expect(before).toMatchObject({
      state: "done",
      resultCount: 1,
      unseen: true,
    });
    expect(after.unseen).toBe(false);
  });

  test("a pending question reads as waiting", () => {
    expect(
      threadStateOf([], { status: "waiting", waitingFor: "question" }),
    ).toBe("waiting");
  });

  test("a conversation that ended before its first turn failed", () => {
    expect(threadStateOf([], GONE)).toBe("failed");
    expect(threadStateOf([], { status: "starting", waitingFor: null })).toBe(
      "working",
    );
  });
});

describe("latestResultOf", () => {
  test("is the newest accepted payload across turns", () => {
    const events = [
      ...searchTurn,
      user("cheaper"),
      say("Nothing cheaper nearby."),
    ];
    const turns = groupThread(events, [picks], IDLE);
    expect(latestResultOf(turns, picks)?.payload).toEqual(PICKS_INPUT);
    expect(latestResultOf(turns, summary)).toBeNull();
  });
});
