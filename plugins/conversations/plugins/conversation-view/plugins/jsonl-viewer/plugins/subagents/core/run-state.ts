import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { hasLiveProcess } from "@plugins/conversations/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { toolResultIsOutcome, type SubagentRequestShape } from "./protocol";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type TaskNotificationEvent = Extract<JsonlEvent, { kind: "task-notification" }>;

/**
 * Where a sub-agent stands, as far as anything on disk can honestly say.
 *
 * Three arms, not two. A sub-agent whose parent never recorded a completion AND
 * whose parent is no longer running was killed, or died with the session — that
 * is **ended without reporting**, a thing the user can act on, and rendering it
 * as "running" would be the card lying about work that stopped minutes ago.
 */
export type SubagentRunState =
  | { kind: "running" }
  | { kind: "finished" }
  | { kind: "ended-without-reporting" };

export interface SubagentRunStateInput {
  /** The parent's `Agent` tool-use id — the join to everything below. */
  toolUseId: string;
  /**
   * The parent's `Agent` tool-call event, if the parent transcript has it yet.
   * Its `result` is the FOREGROUND completion signal.
   */
  agentToolEvent: ToolCallEvent | undefined;
  /** Every `task-notification` in the parent transcript — the BACKGROUND completion signal. */
  taskNotifications: readonly TaskNotificationEvent[];
  /**
   * The sub-agent's own id (the row's `agentId`). A notification for a RESUMED
   * turn carries the id of the `SendMessage` that resumed it, not the original
   * `Agent` call's, so it joins by its `task-id` — which is this id. Absent =
   * no row yet.
   */
  agentId?: string;
  /**
   * When the parent last resumed this sub-agent with a `SendMessage`
   * (`agentResumeTimes`). A completion signal older than this is stale: the
   * agent is working on the resumed turn. Absent = never resumed.
   */
  resumedAt?: string;
  /** From the sub-agent's meta file. `undefined` = it has not landed yet. */
  requestShape: SubagentRequestShape | undefined;
  /**
   * The sub-agent's OWN transcript closes its newest turn (the row's
   * `turnEnded`). `undefined` = no row yet. Positive evidence only.
   */
  turnEnded: boolean | undefined;
  /**
   * The newest `idle_notification` this sub-agent, as a named teammate, sent
   * the parent (`teammateIdleTimes`), and the sub-agent's own newest line
   * (the row's `newestTurnLineAt`). Idle counts only while nothing newer than
   * the notification is in its transcript — a teammate woken by a later
   * message is working again. Absent = not a teammate, or never went idle.
   */
  teammateIdle?: { idleAt: string; newestTurnLineAt: string | null };
  /** The parent conversation's status. */
  conversationStatus: ConversationStatus;
  /**
   * A `Workflow` run spawned this agent, and the run's journal holds its
   * `result` line (the row's `workflow.reported`). The journal is to a workflow
   * agent what the parent's `tool_result` is to a foreground `Agent` call: the
   * one line that means DONE. Absent = not a workflow agent (or no row yet).
   */
  workflowReported?: boolean;
  /**
   * The workflow run this agent belongs to has ENDED (its derived state is no
   * longer `running` — see `workflowRunsOf`). An agent of an ended run that
   * never reported will not report now. Absent = not a workflow agent.
   */
  workflowRunEnded?: boolean;
}

/**
 * The ONE computation of a sub-agent's state, so the card, the pane title and
 * any future consumer cannot disagree.
 *
 * The PARENT transcript is the authority where it speaks, and differently per
 * request shape:
 *
 * - **foreground** — the parent's `tool_result` lands only at completion, so its
 *   presence means finished.
 * - **background** — that `tool_result` is an immediate "launched"
 *   acknowledgement and means nothing; completion arrives later as the
 *   `task-notification` carrying the same tool-use id.
 * - **unknown shape** (meta not landed) — neither signal can be trusted to mean
 *   completion, so fall through.
 *
 * Either completion is withdrawn by a later resume: a `SendMessage` to a
 * stopped sub-agent starts a new turn under the same id, and only the
 * notification that turn ends with (the newest one, joined by the agent's own
 * id since it carries the `SendMessage`'s tool-use id) finishes it again.
 *
 * Then the sub-agent's OWN transcript: the harness streams an assistant message
 * in pieces with `stop_reason: null`, and only the last piece of an ended turn
 * carries `end_turn`. For a sub-agent started by ANOTHER sub-agent this is the
 * only signal there is — its launching call and any notification live in the
 * spawner's transcript, never the conversation's — so without it such a
 * sub-agent read "running" until the whole conversation stopped. It is
 * positive-only (older Claude Code versions never wrote it), and a named
 * teammate woken by a later message appends a user line, which the next read
 * sees as an open turn again.
 *
 * A workflow agent (spawned by a `Workflow` run, not an `Agent` call) joins no
 * call and gets no notification of its own, so it has its own pair of signals,
 * one at each end of this order: its run's journal `result` line decides
 * FIRST — it is as authoritative as a foreground `tool_result` — and its run
 * having ended decides just before liveness, because a run that is over while
 * this agent never reported means the agent was cut off, whatever the parent
 * is doing now. It sits AFTER the agent's own turn end: an agent that closed its
 * turn finished, even if the journal line recording it never landed.
 *
 * A named teammate has one more: the `idle_notification` it sends its lead
 * when its turn is over. Its own `end_turn` marker is often missing (Claude
 * Code 2.1.29x writes a turn's last text piece with `stop_reason: null`), and
 * it gets no task-notification, so without this a teammate that had reported
 * and gone quiet read "running" for as long as its lead lived. It sits beside
 * the turn end, which it stands in for, and is withdrawn by anything the
 * teammate writes after it.
 *
 * Last, the parent's own liveness.
 *
 * Deliberately NO staleness timeout as a fourth answer: a sub-agent that has
 * written nothing for five minutes may be inside one long tool call, and a
 * timeout would turn that into a claim the code cannot support. Surfaces state
 * the observation instead ("no update in 4m", from `lastActivityAt`).
 */
export function subagentRunState(
  input: SubagentRunStateInput,
): SubagentRunState {
  const { toolUseId, agentToolEvent, taskNotifications, requestShape } = input;
  const { agentId, resumedAt } = input;
  // A completion recorded before the newest resume ended an EARLIER turn.
  const current = (at: string) =>
    resumedAt === undefined || Date.parse(at) >= Date.parse(resumedAt);

  if (input.workflowReported === true) return { kind: "finished" };
  if (
    toolResultIsOutcome(requestShape) &&
    agentToolEvent?.result !== undefined &&
    current(agentToolEvent.result.at)
  ) {
    return { kind: "finished" };
  }
  if (
    requestShape === "background" &&
    taskNotifications.some(
      (n) =>
        (n.toolUseId === toolUseId ||
          (agentId !== undefined && n.taskId === agentId)) &&
        current(n.at),
    )
  ) {
    return { kind: "finished" };
  }
  if (input.turnEnded === true) return { kind: "finished" };
  if (input.teammateIdle !== undefined && isStillIdle(input.teammateIdle)) {
    return { kind: "finished" };
  }
  if (input.workflowRunEnded === true) {
    return { kind: "ended-without-reporting" };
  }
  // No completion recorded. The parent is the only thing that can still be
  // hosting it, so its liveness decides between "still going" and "stopped
  // without ever saying so".
  return hasLiveProcess(input.conversationStatus)
    ? { kind: "running" }
    : { kind: "ended-without-reporting" };
}

/** No line newer than the idle notification: the teammate has not been woken since. */
function isStillIdle(idle: {
  idleAt: string;
  newestTurnLineAt: string | null;
}): boolean {
  return (
    idle.newestTurnLineAt === null ||
    Date.parse(idle.newestTurnLineAt) <= Date.parse(idle.idleAt)
  );
}
