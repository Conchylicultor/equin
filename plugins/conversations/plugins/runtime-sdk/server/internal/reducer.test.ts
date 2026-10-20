import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../core";
import { EMPTY_PROJECTION, reduceEvents } from "./reducer";

let t = 1_000;
const at = () => (t += 10);

const started = (seq: number, pid = 42): AgentEvent => ({
  seq,
  t: at(),
  kind: "agent",
  payload: { event: "started", pid, resume: null, resumeAt: null, fork: false },
});
const turnStarted = (
  seq: number,
  text: string,
  promptUuid: string,
): AgentEvent => ({
  seq,
  t: at(),
  kind: "agent",
  payload: { event: "turn_started", turnId: null, promptUuid, text },
});
const sdk = (seq: number, payload: unknown): AgentEvent => ({
  seq,
  t: at(),
  kind: "sdk",
  payload,
});
const init = (seq: number, sid: string) =>
  sdk(seq, { type: "system", subtype: "init", session_id: sid });
const assistant = (seq: number, uuid: string) =>
  sdk(seq, {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { content: [] },
  });
const result = (seq: number) =>
  sdk(seq, { type: "result", subtype: "success" });

/** One whole turn: A answered, then B asked (and, by default, not answered yet). */
const stream: AgentEvent[] = [
  started(1),
  turnStarted(2, "remember APPLE", "p-a"),
  init(3, "sid-1"),
  assistant(4, "a-1"),
  result(5),
  turnStarted(6, "remember BANANA", "p-b"),
];

describe("reduceEvents", () => {
  test("projects session, busy/idle and the rewind anchor", () => {
    const { state, effects } = reduceEvents(EMPTY_PROJECTION, stream);
    expect(state).toMatchObject({
      cursorSeq: 6,
      sessionId: "sid-1",
      working: true,
      agentPid: 42,
      lastPromptUuid: "p-b",
      lastPromptText: "remember BANANA",
      turnReplied: false,
      lastAssistantUuid: "a-1",
      rewindAnchorUuid: "a-1",
    });
    expect(effects.filter((e) => e.kind === "prompt-submitted")).toHaveLength(
      2,
    );
  });

  test("a result ends the turn; an assistant reply means it stays on Stop", () => {
    const { state } = reduceEvents(EMPTY_PROJECTION, [
      ...stream,
      assistant(7, "a-2"),
      result(8),
    ]);
    expect(state.working).toBe(false);
    expect(state.turnReplied).toBe(true);
    expect(state.rewindAnchorUuid).toBe("a-1");
  });

  test("a sub-agent's assistant message is not the turn's reply", () => {
    const { state } = reduceEvents(EMPTY_PROJECTION, [
      ...stream,
      sdk(7, { type: "assistant", uuid: "sub", parent_tool_use_id: "toolu_1" }),
    ]);
    expect(state.turnReplied).toBe(false);
  });

  test("replay from a cursor applies only the lines after it, once", () => {
    const first = reduceEvents(EMPTY_PROJECTION, stream.slice(0, 4));
    // The backend restarts and re-reads the whole file: the applied half is skipped.
    const second = reduceEvents(first.state, stream);
    expect(second.state.cursorSeq).toBe(6);
    expect(second.gaps).toEqual([]);
    expect(second.effects).toEqual([
      {
        kind: "prompt-submitted",
        text: "remember BANANA",
        at: expect.any(Date),
      },
    ]);
    // Replaying again changes nothing.
    const third = reduceEvents(second.state, stream);
    expect(third.state).toEqual(second.state);
    expect(third.effects).toEqual([]);
  });

  test("a seq jump past the cursor is reported as a gap, then applied", () => {
    const first = reduceEvents(EMPTY_PROJECTION, stream.slice(0, 2));
    // Lines 3–5 were rotated out of every kept generation before this read.
    const { state, gaps } = reduceEvents(first.state, stream.slice(5));
    expect(gaps).toEqual([{ from: 3, to: 5 }]);
    expect(state.cursorSeq).toBe(6);
    expect(state.lastPromptUuid).toBe("p-b");
  });

  test("questions: registered on request, retired when withdrawn, kept when answered", () => {
    const request: AgentEvent = {
      seq: 7,
      t: at(),
      kind: "permission_request",
      payload: {
        requestId: "r-1",
        toolUseId: "toolu_q",
        toolName: "AskUserQuestion",
        input: { questions: [] },
      },
    };
    const asked = reduceEvents(EMPTY_PROJECTION, [...stream, request]);
    expect(asked.state.openRequestId).toBe("r-1");
    expect(asked.effects.at(-1)).toEqual({
      kind: "question",
      request: request.payload,
      pid: 42,
    });

    const resolved = (outcome: "answered" | "aborted"): AgentEvent => ({
      seq: 8,
      t: at(),
      kind: "permission_resolved",
      payload: { requestId: "r-1", toolUseId: "toolu_q", outcome },
    });
    const answered = reduceEvents(asked.state, [resolved("answered")]);
    expect(answered.state.openRequestId).toBeNull();
    expect(answered.effects).toEqual([]);
    const aborted = reduceEvents(asked.state, [resolved("aborted")]);
    expect(aborted.effects).toEqual([
      { kind: "question-closed", toolUseId: "toolu_q", outcome: "aborted" },
    ]);
  });

  test("the process exiting ends the turn and retires its open question", () => {
    const { state, effects } = reduceEvents(EMPTY_PROJECTION, [
      ...stream,
      {
        seq: 7,
        t: at(),
        kind: "permission_request",
        payload: {
          requestId: "r",
          toolUseId: "tq",
          toolName: "AskUserQuestion",
          input: {},
        },
      },
      {
        seq: 8,
        t: at(),
        kind: "agent",
        payload: { event: "exited", reason: "x" },
      },
    ]);
    expect(state).toMatchObject({
      working: false,
      agentPid: null,
      openRequestId: null,
    });
    expect(effects.at(-1)).toEqual({
      kind: "question-closed",
      toolUseId: "tq",
      outcome: "aborted",
    });
  });

  test("background tasks keep the count the CLI last reported; an exit clears it", () => {
    const bg = (seq: number, n: number) =>
      sdk(seq, {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: Array.from({ length: n }, (_, i) => ({ task_id: `t-${i}` })),
      });
    const { state } = reduceEvents(EMPTY_PROJECTION, [
      ...stream.slice(0, 3),
      bg(4, 1),
      bg(5, 2),
      result(6),
    ]);
    expect(state).toMatchObject({ working: false, backgroundTasks: 2 });
    const exited = reduceEvents(state, [
      {
        seq: 7,
        t: at(),
        kind: "agent",
        payload: { event: "exited", reason: "x" },
      },
    ]);
    expect(exited.state.backgroundTasks).toBe(0);
  });

  test("a turn the CLI starts by itself (no turn_started) opens on its init", () => {
    const { state } = reduceEvents(EMPTY_PROJECTION, [
      ...stream.slice(0, 5),
      sdk(6, { type: "system", subtype: "task_notification", task_id: "t-0" }),
      init(7, "sid-1"),
      assistant(8, "a-2"),
    ]);
    expect(state.working).toBe(true);
    const ended = reduceEvents(state, [result(9)]);
    expect(ended.state.working).toBe(false);
  });
});
