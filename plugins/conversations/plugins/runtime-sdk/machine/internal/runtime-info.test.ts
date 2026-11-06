import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../core";
import {
  EMPTY_PROJECTION,
  reduceEvents,
  type AgentProjection,
} from "../../server/internal/reducer";
import { reportedStateChanged } from "./runtime-info";

let t = 1_000;
const at = () => (t += 10);
const sdk = (seq: number, payload: unknown): AgentEvent => ({
  seq,
  t: at(),
  kind: "sdk",
  payload,
});
const started = (seq: number): AgentEvent => ({
  seq,
  t: at(),
  kind: "agent",
  payload: {
    event: "started",
    pid: 42,
    resume: null,
    resumeAt: null,
    fork: false,
    turnIds: true,
  },
});
const turnStarted = (seq: number): AgentEvent => ({
  seq,
  t: at(),
  kind: "agent",
  payload: {
    event: "turn_started",
    turnId: `turn-${seq}`,
    promptUuid: `p-${seq}`,
    text: "go",
  },
});
const assistant = (seq: number) =>
  sdk(seq, {
    type: "assistant",
    uuid: `a-${seq}`,
    parent_tool_use_id: null,
    message: { content: [] },
  });
const toolResult = (seq: number) =>
  sdk(seq, {
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
  });

/** Apply `events` to `from`, and say whether the batch would signal. */
function batch(from: AgentProjection, events: AgentEvent[]) {
  const { state } = reduceEvents(from, events);
  return { state, signals: reportedStateChanged(from, state) };
}

describe("reportedStateChanged", () => {
  const running = reduceEvents(EMPTY_PROJECTION, [
    started(1),
    turnStarted(2),
    sdk(3, { type: "system", subtype: "init", session_id: "sid-1" }),
  ]).state;

  test("a mid-turn batch of assistant text and tool results does not signal", () => {
    const { state, signals } = batch(running, [
      assistant(4),
      toolResult(5),
      assistant(6),
    ]);
    expect(state.cursorSeq).toBe(6);
    expect(signals).toBe(false);
  });

  test("the turn's end signals", () => {
    expect(
      batch(running, [assistant(4), sdk(5, { type: "result" })]).signals,
    ).toBe(true);
  });

  test("a turn's start, a new session and the process starting or exiting signal", () => {
    const atRest = batch(running, [sdk(4, { type: "result" })]).state;
    expect(batch(atRest, [turnStarted(5)]).signals).toBe(true);
    expect(
      batch(running, [
        sdk(4, { type: "system", subtype: "init", session_id: "sid-2" }),
      ]).signals,
    ).toBe(true);
    expect(batch(EMPTY_PROJECTION, [started(1)]).signals).toBe(true);
    expect(
      batch(running, [
        {
          seq: 4,
          t: at(),
          kind: "agent",
          payload: { event: "exited", reason: "shutdown" },
        },
      ]).signals,
    ).toBe(true);
  });

  test("background work starting or ending signals", () => {
    const atRest = batch(running, [sdk(4, { type: "result" })]).state;
    expect(
      batch(atRest, [
        sdk(5, {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ id: "b" }],
        }),
      ]).signals,
    ).toBe(true);
  });
});
