import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import type { ThreadResultDef } from "./result";
import type { ThreadConversation, ThreadTurn } from "./group-thread";

/**
 * Where a thread stands as a whole — what its header (and a host's progress
 * pill) says:
 * - `working` — the agent is on the newest turn (or starting up);
 * - `waiting` — it asked the user something and waits for the answer;
 * - `done` — it ended its turn with an answer or a result;
 * - `failed` — it ended its turn with neither, or the conversation ended
 *   before saying anything.
 */
export type ThreadState = "working" | "waiting" | "done" | "failed";

export interface ThreadProgress {
  state: ThreadState;
  /** The newest turn's finished steps. */
  stepsDone: number;
  /** The step the agent is on now, or null when none is running. */
  currentStep: ToolCallEvent | null;
  /** The newest turn's accepted results. */
  resultCount: number;
  /** The thread said something (an answer, a result) the user has not seen. */
  unseen: boolean;
}

/** What progress reads off the conversation row, beyond `groupThread`'s. */
export interface ProgressConversation extends ThreadConversation {
  lastViewedAt: Date | null;
}

export function threadStateOf(
  turns: readonly ThreadTurn[],
  conversation: ThreadConversation,
): ThreadState {
  if (conversation.waitingFor !== null) return "waiting";
  const last = turns.at(-1);
  if (!last) {
    switch (conversation.status) {
      case "starting":
      case "working":
        return "working";
      case "gone":
      case "done":
        return "failed";
      case "waiting":
        return "done";
    }
  }
  switch (last.state) {
    case "running":
      return "working";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

/** When the thread last said something: its newest answer or result. */
export function latestOutputAt(turns: readonly ThreadTurn[]): number | null {
  let latest: number | null = null;
  for (const turn of turns) {
    const stamps = [
      ...(turn.answer ? [turn.answer.at] : []),
      ...turn.results.map((r) => r.at),
    ];
    for (const at of stamps) {
      const t = Date.parse(at);
      if (latest === null || t > latest) latest = t;
    }
  }
  return latest;
}

export function threadProgressOf<D extends ThreadResultDef>(
  turns: readonly ThreadTurn<D>[],
  conversation: ProgressConversation,
): ThreadProgress {
  const last = turns.at(-1);
  const steps = last?.steps ?? [];
  const output = latestOutputAt(turns);
  return {
    state: threadStateOf(turns, conversation),
    stepsDone: steps.filter((s) => s.state !== "running").length,
    currentStep: steps.findLast((s) => s.state === "running")?.event ?? null,
    resultCount: (last?.results ?? []).filter((r) => r.kind === "accepted")
      .length,
    unseen:
      output !== null &&
      (conversation.lastViewedAt === null ||
        output > conversation.lastViewedAt.getTime()),
  };
}

/** The newest accepted payload of kind `def` across the thread, or null. */
export function latestResultOf<T>(
  turns: readonly ThreadTurn[],
  def: ThreadResultDef<T>,
): { payload: T; at: string } | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const hit = turns[i]!.results.findLast(
      (r) => r.kind === "accepted" && r.def.tool === def.tool,
    );
    if (hit?.kind === "accepted") {
      return { payload: hit.payload as T, at: hit.at };
    }
  }
  return null;
}
