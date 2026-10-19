import type { AgentEvent, OpenRequest } from "../../core";

// Event lines → the conversation's projection, plus the side effects the
// consumer must run for them. Pure: lines in, state and effects out, so replay
// from a cursor and a rotation gap are unit tests (reducer.test.ts).

/** What the backend keeps of one agent's event stream (`conversations_ext_sdk_agent`). */
export interface AgentProjection {
  /** The last seq applied. */
  cursorSeq: number;
  /** The Claude session id (`system/init`), the conversation's live tail. */
  sessionId: string | null;
  /** Between a turn's start and its `result` (or the process's exit). */
  working: boolean;
  /** When the agent wrote the event `working` rests on. */
  statusAt: Date | null;
  cliVersion: string | null;
  /** The live agent process (a held question's holder). */
  agentPid: number | null;
  /** The AskUserQuestion parked in `canUseTool`, if any. */
  openRequestId: string | null;
  openToolUseId: string | null;
  /** The latest turn the agent took, and whether the agent has answered it yet. */
  lastPromptUuid: string | null;
  lastPromptText: string | null;
  turnReplied: boolean;
  /** The last top-level assistant message. */
  lastAssistantUuid: string | null;
  /**
   * Where a rewind of the latest turn resumes: the last assistant message
   * BEFORE it (null when the turn was the session's first).
   */
  rewindAnchorUuid: string | null;
}

export const EMPTY_PROJECTION: AgentProjection = {
  cursorSeq: 0,
  sessionId: null,
  working: false,
  statusAt: null,
  cliVersion: null,
  agentPid: null,
  openRequestId: null,
  openToolUseId: null,
  lastPromptUuid: null,
  lastPromptText: null,
  turnReplied: false,
  lastAssistantUuid: null,
  rewindAnchorUuid: null,
};

/** What the consumer must do for the lines it applied, in order. */
export type AgentEffect =
  /** A question was asked: register it with the question relay (the web form). */
  | { kind: "question"; request: OpenRequest; pid: number | null }
  /** A question stopped waiting without the web answering it. */
  | {
      kind: "question-closed";
      toolUseId: string;
      outcome: "dismissed" | "aborted";
    }
  /** The SDK took a turn: the turn ledger confirms it. */
  | { kind: "prompt-submitted"; text: string; at: Date };

/** Lines the file skipped over: more rotations than the sink keeps were missed. */
export interface SeqGap {
  from: number;
  to: number;
}

export interface ReduceResult {
  state: AgentProjection;
  effects: AgentEffect[];
  gaps: SeqGap[];
}

interface SdkLike {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  uuid?: unknown;
  parent_tool_use_id?: unknown;
  message?: { content?: unknown };
}

function hasToolResult(msg: SdkLike): boolean {
  const content = msg.message?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "tool_result",
    )
  );
}

/**
 * Apply `events` (in file order) on top of `state`. Lines at or below the
 * cursor are skipped — replaying a file from the start is a no-op — and a seq
 * jumping past `cursor + 1` is reported as a gap, then applied anyway.
 */
export function reduceEvents(
  state: AgentProjection,
  events: readonly AgentEvent[],
): ReduceResult {
  const s = { ...state };
  const effects: AgentEffect[] = [];
  const gaps: SeqGap[] = [];
  for (const e of events) {
    if (e.seq <= s.cursorSeq) continue;
    if (e.seq > s.cursorSeq + 1) {
      gaps.push({ from: s.cursorSeq + 1, to: e.seq - 1 });
    }
    s.cursorSeq = e.seq;
    const at = new Date(e.t);
    switch (e.kind) {
      case "agent": {
        const p = e.payload;
        switch (p.event) {
          case "started":
            s.agentPid = p.pid;
            // A new process holds no question and runs no turn yet.
            s.working = false;
            s.statusAt = at;
            s.openRequestId = null;
            s.openToolUseId = null;
            break;
          case "ready":
            s.cliVersion = p.cliVersion;
            break;
          case "turn_started":
            s.working = true;
            s.statusAt = at;
            s.rewindAnchorUuid = s.lastAssistantUuid;
            s.lastPromptUuid = p.promptUuid;
            s.lastPromptText = p.text;
            s.turnReplied = false;
            effects.push({ kind: "prompt-submitted", text: p.text, at });
            break;
          case "exited":
            s.working = false;
            s.statusAt = at;
            s.agentPid = null;
            if (s.openToolUseId) {
              effects.push({
                kind: "question-closed",
                toolUseId: s.openToolUseId,
                outcome: "aborted",
              });
            }
            s.openRequestId = null;
            s.openToolUseId = null;
            break;
        }
        break;
      }
      case "permission_request":
        s.openRequestId = e.payload.requestId;
        s.openToolUseId = e.payload.toolUseId;
        effects.push({ kind: "question", request: e.payload, pid: s.agentPid });
        break;
      case "permission_resolved":
        if (s.openRequestId === e.payload.requestId) {
          s.openRequestId = null;
          s.openToolUseId = null;
        }
        if (e.payload.outcome !== "answered") {
          effects.push({
            kind: "question-closed",
            toolUseId: e.payload.toolUseId,
            outcome: e.payload.outcome,
          });
        }
        break;
      case "sdk": {
        const msg = (e.payload ?? {}) as SdkLike;
        if (
          msg.type === "system" &&
          msg.subtype === "init" &&
          typeof msg.session_id === "string"
        ) {
          s.sessionId = msg.session_id;
        } else if (
          msg.type === "assistant" &&
          msg.parent_tool_use_id == null &&
          typeof msg.uuid === "string"
        ) {
          s.lastAssistantUuid = msg.uuid;
          s.turnReplied = true;
        } else if (
          msg.type === "user" &&
          msg.parent_tool_use_id == null &&
          hasToolResult(msg)
        ) {
          // A tool result means the agent is mid-turn (the transcript rule of
          // `cutTranscriptAtUnansweredPrompt`).
          s.turnReplied = true;
        } else if (msg.type === "result") {
          s.working = false;
          s.statusAt = at;
        }
        break;
      }
    }
  }
  return { state: s, effects, gaps };
}
