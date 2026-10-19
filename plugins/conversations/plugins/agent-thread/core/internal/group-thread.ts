import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import {
  toolName,
  type ToolCallEvent,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import type { ThreadResultDef } from "./result";

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
 * tool took whose input parses under the kind's schema; `invalid` is a call
 * the tool took whose input does NOT parse here (the schema changed since the
 * transcript was written) — a state the view renders, never a payload to
 * guess from. A call the tool refused (its result an error) is not a result
 * at all: it is a step, drawn red.
 *
 * Distributes over a union of kinds, so `def` and `payload` stay paired.
 */
export type ThreadResult<D extends ThreadResultDef = ThreadResultDef> =
  D extends ThreadResultDef<infer T>
    ? | {
          kind: "accepted";
          def: D;
          payload: T;
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

/** One exchange: what the user said, and everything the agent did about it. */
export interface ThreadTurn<D extends ThreadResultDef = ThreadResultDef> {
  user: { text: string; at: string };
  steps: ThreadStep[];
  /** The turn's last assistant text, or null when it wrote none. */
  answer: { text: string; at: string } | null;
  /** In delivery order; a later call of one kind replaces the earlier one. */
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
  answer: { text: string; at: string } | null;
}

function resultOf<D extends ThreadResultDef>(
  def: D,
  event: ToolCallEvent,
): ThreadResult<D> {
  const parsed = def.schema.safeParse(event.input);
  const base = { def, at: event.at, toolUseId: event.toolUseId };
  return (
    parsed.success
      ? { kind: "accepted", payload: parsed.data, ...base }
      : { kind: "invalid", error: parsed.error.message, ...base }
  ) as ThreadResult<D>;
}

function closeTurn<D extends ThreadResultDef>(
  draft: TurnDraft,
  defs: ReadonlyMap<string, D>,
  running: boolean,
): ThreadTurn<D> {
  const steps: ThreadStep[] = [];
  // Keyed by kind: re-inserting moves a replacing call to its own position.
  const results = new Map<string, ThreadResult<D>>();
  for (const event of draft.calls) {
    const def = defs.get(toolName(event.name).name);
    if (def && event.result && !event.result.isError) {
      results.delete(def.tool);
      results.set(def.tool, resultOf(def, event));
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
 */
export function groupThread<D extends ThreadResultDef>(
  events: readonly JsonlEvent[],
  results: readonly D[],
  conversation: ThreadConversation,
): ThreadTurn<D>[] {
  const defs = new Map<string, D>();
  for (const def of results) {
    if (defs.has(def.tool)) {
      throw new Error(`groupThread: result tool "${def.tool}" is listed twice`);
    }
    defs.set(def.tool, def);
  }

  const drafts: TurnDraft[] = [];
  for (const event of events) {
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
      draft.answer = { text: event.text, at: event.at };
  }

  const runs = lastTurnRuns(conversation);
  return drafts.map((draft, i) =>
    closeTurn(draft, defs, runs && i === drafts.length - 1),
  );
}
