import { z } from "zod";
import type { AgentEvent, AgentLifecycle, OpenRequest } from "../../core";

// Event lines → the conversation's projection, plus the side effects the
// consumer must run for them. Pure: lines in, state and effects out, so replay
// from a cursor and a rotation gap are unit tests (reducer.test.ts).

/** What the backend keeps of one agent's event stream (`conversations_ext_sdk_agent`). */
export interface AgentProjection {
  /** The last seq applied. */
  cursorSeq: number;
  /** The Claude session id (`system/init`), the conversation's live tail. */
  sessionId: string | null;
  /**
   * Between a turn's start and its `result` (or the process's exit). A turn
   * starts on the prompt the agent fed (`turn_started`) or on the CLI's own
   * `system/init`, which also opens the turns the CLI starts by itself (a
   * background task's completion notification) — no `turn_started` marks those.
   */
  working: boolean;
  /**
   * How many background tasks (backgrounded commands, background subagents)
   * the agent has in flight — the last `system/background_tasks_changed`. Each
   * one re-invokes the agent when it finishes, so the agent is busy while any
   * is pending even between turns.
   */
  backgroundTasks: number;
  /** When the agent wrote the event `working` / `backgroundTasks` rests on. */
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
  /** The Claude account the agent process runs on (`started`); null before one says. */
  account: string | null;
  /**
   * When the agent last stopped at its account's usage limit (the CLI's
   * synthetic `error: "rate_limit"` assistant message), until a turn runs past
   * it or a new process starts.
   */
  limitHitAt: Date | null;
}

export const EMPTY_PROJECTION: AgentProjection = {
  cursorSeq: 0,
  sessionId: null,
  working: false,
  backgroundTasks: 0,
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
  account: null,
  limitHitAt: null,
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

/**
 * A line of a kind the projection reads (a `system` subtype below) whose shape
 * did not parse: applied as nothing — the cursor still moves past it, so one
 * bad line never stalls the stream — and reported by the consumer.
 */
export interface MalformedEvent {
  seq: number;
  subtype: string;
  issue: string;
}

/**
 * The agent's exit stalled and it killed itself (`exit_stalled`): reported by
 * the consumer, with the diagnosis the agent captured.
 */
export type ExitStall = Extract<AgentLifecycle, { event: "exit_stalled" }> & {
  seq: number;
};

export interface ReduceResult {
  state: AgentProjection;
  effects: AgentEffect[];
  gaps: SeqGap[];
  malformed: MalformedEvent[];
  stalls: ExitStall[];
}

/**
 * The `system` subtypes the projection reads, each with the shape it reads.
 * A subtype not listed here is not the projection's business; a listed one
 * that fails its schema is a {@link MalformedEvent}, never silently skipped.
 */
const SYSTEM_SCHEMAS = {
  init: z.object({ session_id: z.string() }),
  background_tasks_changed: z.object({ tasks: z.array(z.unknown()) }),
};

function isReadSubtype(
  subtype: unknown,
): subtype is keyof typeof SYSTEM_SCHEMAS {
  return typeof subtype === "string" && Object.hasOwn(SYSTEM_SCHEMAS, subtype);
}

interface SdkLike {
  type?: unknown;
  subtype?: unknown;
  uuid?: unknown;
  parent_tool_use_id?: unknown;
  error?: unknown;
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
  const malformed: MalformedEvent[] = [];
  const stalls: ExitStall[] = [];
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
            // A new process holds no question, runs no turn and has no
            // background task yet.
            s.working = false;
            s.backgroundTasks = 0;
            s.statusAt = at;
            s.openRequestId = null;
            s.openToolUseId = null;
            s.account = p.account ?? null;
            s.limitHitAt = null;
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
            s.limitHitAt = null;
            effects.push({ kind: "prompt-submitted", text: p.text, at });
            break;
          case "exited":
            // Its background tasks die with it.
            s.working = false;
            s.backgroundTasks = 0;
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
          case "exit_stalled":
            // Follows `exited`, which already cleared the state.
            stalls.push({ ...p, seq: e.seq });
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
        if (msg.type === "system" && isReadSubtype(msg.subtype)) {
          const subtype = msg.subtype;
          switch (subtype) {
            case "init": {
              const parsed = SYSTEM_SCHEMAS.init.safeParse(msg);
              if (!parsed.success) {
                malformed.push({
                  seq: e.seq,
                  subtype,
                  issue: parsed.error.message,
                });
                break;
              }
              s.sessionId = parsed.data.session_id;
              if (!s.working) {
                s.working = true;
                s.statusAt = at;
              }
              break;
            }
            case "background_tasks_changed": {
              const parsed =
                SYSTEM_SCHEMAS.background_tasks_changed.safeParse(msg);
              if (!parsed.success) {
                malformed.push({
                  seq: e.seq,
                  subtype,
                  issue: parsed.error.message,
                });
                break;
              }
              s.backgroundTasks = parsed.data.tasks.length;
              s.statusAt = at;
              break;
            }
          }
        } else if (
          msg.type === "assistant" &&
          msg.parent_tool_use_id == null &&
          typeof msg.uuid === "string"
        ) {
          s.lastAssistantUuid = msg.uuid;
          s.turnReplied = true;
          // The CLI's own notice that the account's usage limit stopped the turn.
          if (msg.error === "rate_limit") s.limitHitAt = at;
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
  return { state: s, effects, gaps, malformed, stalls };
}
