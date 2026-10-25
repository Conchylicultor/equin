import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  toolName,
  type ToolCallEvent,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { parseThreadResultOutput, type ThreadResultDef } from "./result";

/**
 * Where one tool call stands: `running` while it has no result and its turn is
 * still going, `done` once it returned, `error` when it returned an error — or
 * never returned and its turn is over (the agent was stopped, or died).
 */
export type ThreadStepState = "running" | "done" | "error";

/** One step of a turn: a tool call the agent made that is not a result. */
export interface ThreadStep {
  event: ToolCallEvent;
  state: ThreadStepState;
}

/**
 * One result a turn delivered, typed by its kind. `accepted` is a call the
 * tool took whose input parses under the kind's schema — and, for a kind
 * declaring an `output`, whose result parses under that one (`output`;
 * `undefined` for a kind declaring none); `invalid` is a call the tool took
 * whose input or output does NOT parse here (the schema changed since the
 * transcript was written) — a state the view renders, never a payload to
 * guess from. A call the tool refused (its result an error) is not a result
 * at all: it is a step, drawn red.
 *
 * Distributes over a union of kinds, so `def`, `payload` and `output` stay
 * paired.
 */
export type ThreadResult<D extends ThreadResultDef = ThreadResultDef> =
  D extends ThreadResultDef<infer T, infer O>
    ? | {
          kind: "accepted";
          def: D;
          payload: T;
          output: O;
          at: string;
          toolUseId: string;
        }
      | {
          kind: "invalid";
          def: D;
          error: string;
          at: string;
          toolUseId: string;
        }
    : never;

/** An accepted result of one of the kinds `D`, as a host renders it. */
export type AcceptedThreadResult<D extends ThreadResultDef = ThreadResultDef> =
  Extract<ThreadResult<D>, { kind: "accepted" }>;

/**
 * `running` while the agent is still on it (or blocked on the user mid-turn),
 * `done` once it ended with an answer or a result, `failed` once it ended with
 * neither.
 */
export type ThreadTurnState = "running" | "done" | "failed";

/**
 * A turn's answer: its text, when it was written, and the API message that
 * carried it — the identity of the active-data blocks it holds (null on a
 * transcript line that names none).
 */
export interface ThreadAnswer {
  text: string;
  at: string;
  messageId: string | null;
  /**
   * The agent is still writing it: a block of the message being streamed,
   * not in the transcript yet — `text` is what has been written so far.
   */
  streaming: boolean;
}

/** One exchange: what the user said, and everything the agent did about it. */
export interface ThreadTurn<D extends ThreadResultDef = ThreadResultDef> {
  user: { text: string; at: string };
  steps: ThreadStep[];
  /** The turn's last assistant text, or null when it wrote none. */
  answer: ThreadAnswer | null;
  /**
   * In delivery order. A later call of one kind replaces the earlier one,
   * unless the kind is `multiple` (each call is its own result).
   */
  results: ThreadResult<D>[];
  state: ThreadTurnState;
}

/** What `groupThread` reads off the conversation row. */
export interface ThreadConversation {
  status: ConversationStatus;
  waitingFor: string | null;
}

/** Whether the conversation's newest turn is still in the agent's hands. */
function lastTurnRuns(conversation: ThreadConversation): boolean {
  return (
    conversation.status === "starting" ||
    conversation.status === "working" ||
    conversation.waitingFor !== null
  );
}

interface TurnDraft {
  user: { text: string; at: string };
  calls: ToolCallEvent[];
  answer: ThreadAnswer | null;
}

function resultOf<D extends ThreadResultDef>(
  def: D,
  event: ToolCallEvent,
  content: string,
): ThreadResult<D> {
  const base = { def, at: event.at, toolUseId: event.toolUseId };
  const parsed = def.schema.safeParse(event.input);
  if (!parsed.success) {
    return {
      kind: "invalid",
      error: parsed.error.message,
      ...base,
    } as ThreadResult<D>;
  }
  if (def.output === undefined) {
    return {
      kind: "accepted",
      payload: parsed.data,
      output: undefined,
      ...base,
    } as ThreadResult<D>;
  }
  const output = parseThreadResultOutput(def.output, content);
  return (
    output.ok
      ? {
          kind: "accepted",
          payload: parsed.data,
          output: output.output,
          ...base,
        }
      : { kind: "invalid", error: output.error, ...base }
  ) as ThreadResult<D>;
}

function closeTurn<D extends ThreadResultDef>(
  draft: TurnDraft,
  defs: ReadonlyMap<string, D>,
  running: boolean,
): ThreadTurn<D> {
  const steps: ThreadStep[] = [];
  // Keyed by kind (by call for a `multiple` kind): re-inserting moves a
  // replacing call to its own position.
  const results = new Map<string, ThreadResult<D>>();
  for (const event of draft.calls) {
    const def = defs.get(toolName(event.name).name);
    if (def && event.result && !event.result.isError) {
      const key = def.multiple ? `call:${event.toolUseId}` : `kind:${def.tool}`;
      results.delete(key);
      results.set(key, resultOf(def, event, event.result.content));
      continue;
    }
    steps.push({
      event,
      state: event.result
        ? event.result.isError
          ? "error"
          : "done"
        : running
          ? "running"
          : "error",
    });
  }
  const delivered = [...results.values()];
  return {
    user: draft.user,
    steps,
    answer: draft.answer,
    results: delivered,
    state: running
      ? "running"
      : draft.answer !== null || delivered.length > 0
        ? "done"
        : "failed",
  };
}

/**
 * Fold a conversation's transcript into the turns of its thread. A turn opens
 * at each `user-text`; whatever comes before the first (the harness context)
 * belongs to no turn. Inside a turn, each tool call is a step, unless it is an
 * accepted call of one of `results`' tools, which makes it a result; the
 * turn's last assistant text is its answer.
 *
 * Only the newest turn can still be running, and it is exactly while the
 * conversation is starting, working, or waiting on the user mid-turn (a
 * question, a menu). Every other turn is over: done with an answer or a
 * result, failed with neither.
 *
 * `events` is the transcript as rendered (`useVisibleEvents`), so an event a
 * filter hides (a question's raw answer turn) never opens a turn.
 *
 * `writing` is the message the agent is streaming, as stand-ins for the events
 * it will become (jsonl-viewer's `useStreamingStandIns`): while the newest turn
 * runs, its text is the turn's answer as far as it is written (`streaming`),
 * until the transcript holds it — the same words the transcript reveals. Its
 * tool calls join as steps once the transcript holds them (a streaming call's
 * input is still incomplete).
 */
export function groupThread<D extends ThreadResultDef>(
  events: readonly JsonlEvent[],
  results: readonly D[],
  conversation: ThreadConversation,
  writing: readonly JsonlEvent[] = [],
): ThreadTurn<D>[] {
  const defs = new Map<string, D>();
  for (const def of results) {
    if (defs.has(def.tool)) {
      throw new Error(`groupThread: result tool "${def.tool}" is listed twice`);
    }
    defs.set(def.tool, def);
  }

  const runs = lastTurnRuns(conversation);
  const streamed = new Set<JsonlEvent>(
    runs ? writing.filter((e) => e.kind === "assistant-text") : [],
  );
  const drafts: TurnDraft[] = [];
  for (const event of [...events, ...streamed]) {
    if (event.kind === "user-text") {
      drafts.push({
        user: { text: event.text, at: event.at },
        calls: [],
        answer: null,
      });
      continue;
    }
    const draft = drafts.at(-1);
    if (!draft) continue;
    if (event.kind === "tool-call") draft.calls.push(event);
    else if (event.kind === "assistant-text" && event.text.trim() !== "")
      draft.answer = {
        text: event.text,
        at: event.at,
        messageId: event.messageId ?? null,
        streaming: streamed.has(event),
      };
  }

  return drafts.map((draft, i) =>
    closeTurn(draft, defs, runs && i === drafts.length - 1),
  );
}
