import { useLive } from "@plugins/network/plugins/live/web";
import { combineResources } from "@plugins/primitives/plugins/live-state/web";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import { useConversationById } from "@plugins/conversations/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  agentCallForSubagent,
  agentCallJoin,
  describedSubagent,
  conversationParentFacts,
  subagentActivity,
  subagentRunState,
  workflowRunsOf,
  type DescribedSubagent,
  type LastStep,
  type SubagentActivityRow,
  type SubagentRunState,
  type SubagentRunStateInput,
  type WorkflowRunEntry,
} from "../../core";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type TaskNotificationEvent = Extract<JsonlEvent, { kind: "task-notification" }>;

function agentCallsOf(events: readonly JsonlEvent[]): ToolCallEvent[] {
  return events.filter((e): e is ToolCallEvent => e.kind === "tool-call");
}

/**
 * One sub-agent of a conversation, with everything a list of them needs said
 * about it in one place.
 *
 * The row arm is deliberately the whole union: what a sub-agent last did and
 * when it started come from the FILESYSTEM, so they survive a meta file nothing
 * could read — a surface listing sub-agents still shows one whose metadata is
 * corrupt, rather than pretending it does not exist.
 */
export interface SubagentEntry {
  row: SubagentActivityRow;
  state: SubagentRunState;
  /** The meta file's stamp — when the harness created it. */
  startedAt: Date;
  /** When it last wrote. `null` while it is still running. */
  endedAt: Date | null;
  /** `null` = it has written nothing classifiable yet, not "it did nothing". */
  lastStep: LastStep | null;
  /**
   * The parent's `Agent` call that spawned it, when the parent transcript holds
   * one (`agentCallForSubagent`). Absent for an in-process teammate whose call
   * has scrolled out of the kept chain, and for every undescribed row.
   */
  agentToolEvent: ToolCallEvent | undefined;
}

/** The sub-agent reads need the computer, and this host has none behind it. */
export interface SubagentsUnavailable {
  kind: "unavailable";
  /** The sentence to show in place of the sub-agent surface. */
  message: string;
}

/**
 * Everything a surface needs to say about one sub-agent, in one read.
 *
 * `pending` is a real arm, not a nullable value: the run state is computed from
 * the PARENT transcript and the parent's own liveness, so until both have
 * arrived there is no honest answer — and "running" is the answer a surface
 * would otherwise default to, which is the one claim that ages into a lie.
 */
export type SubagentStatus =
  | { kind: "pending" }
  /** A read behind the answer FAILED — render it with Retry, never as a spinner. */
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  /**
   * Nothing here can watch sub-agents: their files are on a computer this host
   * does not have (an in-browser server). Settled, never arriving — a card
   * renders from its transcript alone, with no run state, never "running".
   */
  | SubagentsUnavailable
  | {
      kind: "known";
      state: SubagentRunState;
      /**
       * `undefined` while the harness has not written the sub-agent's meta file
       * — it is STARTING, which is not the same as having done nothing. It is
       * also how a conversation whose sub-agent files have been cleaned up
       * reads, which is why the state below never depends on this being set.
       *
       * Always the DESCRIBED arm: only a described row carries the `toolUseId`
       * a card joins on, so a row reachable from a card is described by
       * construction. Its own optional fields (`model`, `requestShape`, …) stay
       * optional — present means the harness recorded it, absent means it did
       * not, and a surface renders the absence rather than filling it in.
       */
      row: DescribedSubagent | undefined;
      /** The meta file's stamp, else the parent's own `Agent` call time. */
      startedAt: Date | null;
      /** When it last wrote. `null` while it is still running. */
      endedAt: Date | null;
    };

/**
 * Every sub-agent of one conversation, and the per-card read over the same data.
 *
 * `pending` until all three reads have landed, and one arm for the whole set:
 * "how many are working" must never be answered from a half-arrived transcript,
 * because the answer a surface would show — a count, an empty band — is a claim
 * about the user's work that then reverses itself.
 */
export type ConversationSubagents =
  | { kind: "pending" }
  /**
   * A read behind the set FAILED rather than is still arriving — a surface
   * renders it as an error with Retry, never as a spinner or an empty set.
   */
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  /**
   * The set cannot be read on this host at all (`subagentActivity` needs the
   * computer). Never an empty set: "no sub-agents" is a claim about the
   * conversation, this is a fact about the host. A list hides itself; a pane
   * shows `message`.
   */
  | SubagentsUnavailable
  | {
      kind: "known";
      /** Every sub-agent of the conversation, in start order. */
      entries: SubagentEntry[];
      /**
       * The same reading, as the card that launched ONE sub-agent sees it —
       * joined from the call rather than from the row, because a card holds its
       * own `Agent` event and that is the stronger evidence: the reverse join
       * can refuse (two calls asking for one name), and a card never has to.
       */
      statusOf: (args: {
        toolUseId: string;
        agentToolEvent: ToolCallEvent | undefined;
      }) => SubagentStatus;
      /**
       * Every `Agent` tool-call of the WHOLE parent transcript, in order —
       * the pane's header and report read the call that launched its
       * sub-agent from here, however far back it sits.
       */
      agentCalls: ToolCallEvent[];
      /**
       * Every `Workflow` run one of the entries belongs to, in start order —
       * the parent a list draws a run's agents under. Derived here, once, from
       * the same reads, so the state a run row shows and the
       * `workflowRunEnded` each of its agents was given cannot disagree.
       */
      workflowRuns: WorkflowRunEntry[];
    };

/**
 * The conversation's sub-agents — the list-level twin of `useSubagentStatus`,
 * and the one place the row ⇄ `Agent`-call join is done.
 *
 * Every caller in a conversation subscribes on the same id, and that is
 * deliberate: `useLive` is a TanStack Query wrapper, so N callers on
 * identical params share ONE query and ONE subscription. A band listing every
 * running sub-agent and a hundred cards each reading their own therefore cost
 * the same three reads.
 */
export function useConversationSubagents(
  conversationId: string | null,
): ConversationSubagents {
  // No conversation yet: both reads are skipped (nothing subscribed) and stay
  // pending, as the gate below reports.
  const params = conversationId === null ? null : { id: conversationId };
  const activity = useLive(subagentActivity, params);
  // The parent-transcript facts are only ever joined onto activity rows, so a
  // host that cannot list the sub-agents (no computer behind the page:
  // `subagentActivity` is `needsMachine`) has nothing to join them to — the
  // read is skipped rather than asked of a host that does not serve it.
  const facts = useLive(
    conversationParentFacts,
    activity.status === "unavailable" ? null : params,
  );
  const conversation = useConversationById(conversationId);

  // Gate FIRST, derive after — nothing below may run on a half-arrived read.
  // The parent transcript is where a BACKGROUND sub-agent's completion lives,
  // so reading a still-loading transcript as "no notifications" would report a
  // finished sub-agent as running until it landed: a surface asserting
  // something false about the user's work, which is the whole reason this arm
  // exists.
  if (activity.status === "unavailable") {
    return { kind: "unavailable", message: activity.message };
  }
  const reads = combineResources({ activity, facts });
  if (reads.status === "error") {
    return { kind: "failed", error: reads.error, refetch: reads.refetch };
  }
  if (reads.status === "loading" || conversation === null) {
    return { kind: "pending" };
  }

  const rows = reads.data.activity;
  const { idleTimes, resumeTimes, stopTimes } = reads.data.facts;
  // The server filtered these by kind; the wire type is the whole event union.
  const taskNotifications = reads.data.facts.taskNotifications.filter(
    (e): e is TaskNotificationEvent => e.kind === "task-notification",
  );
  const agentCalls = agentCallsOf(reads.data.facts.agentCalls);
  const workflowCalls = reads.data.facts.workflowCalls.filter(
    (e): e is ToolCallEvent => e.kind === "tool-call",
  );
  const conversationStatus = conversation.status;
  // A resumed sub-agent's later notifications carry the resuming
  // `SendMessage`'s tool-use id, so they join by its own id; and any completion
  // older than its newest resume ended an earlier turn.
  const resumeInputs = (
    row: SubagentActivityRow | undefined,
  ): Pick<SubagentRunStateInput, "agentId" | "resumedAt"> => {
    if (row === undefined) return {};
    const resumedAt = resumeTimes[row.agentId];
    return resumedAt === undefined
      ? { agentId: row.agentId }
      : { agentId: row.agentId, resumedAt };
  };
  // A teammate's idle notification names it by the name it was spawned with.
  // A name more than one row answers to refuses, exactly as the card join
  // does: either reading would put one teammate's idle on the other.
  const nameCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "described" && row.name !== undefined) {
      nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
    }
  }
  const teammateInputs = (
    row: SubagentActivityRow | undefined,
  ): Pick<SubagentRunStateInput, "teammateIdle"> => {
    if (row?.kind !== "described" || row.name === undefined) return {};
    if (nameCounts.get(row.name) !== 1) return {};
    const idleAt = idleTimes[row.name];
    return idleAt === undefined
      ? {}
      : { teammateIdle: { idleAt, newestTurnLineAt: row.newestTurnLineAt } };
  };

  const workflowRuns = workflowRunsOf({
    rows,
    workflowCalls,
    taskNotifications,
    stopTimes,
    conversationStatus,
  });
  const runEnded = new Map(
    workflowRuns.map((run) => [run.runId, run.state.kind !== "running"]),
  );
  // A workflow agent's own completion signals — its run's journal line, and
  // its run having ended — or nothing at all for every other sub-agent, which
  // leaves `subagentRunState` exactly as it was for them.
  const workflowInputs = (
    row: SubagentActivityRow | undefined,
  ): Pick<SubagentRunStateInput, "workflowReported" | "workflowRunEnded"> =>
    row?.workflow === undefined
      ? {}
      : {
          workflowReported: row.workflow.reported,
          workflowRunEnded: runEnded.get(row.workflow.runId),
        };

  const entries = rows.map((row): SubagentEntry => {
    const agentToolEvent = agentCallForSubagent(row, agentCalls);
    const state = subagentRunState({
      // The row's own id when it has one, else the id of the call that named it
      // — a teammate's completion notification carries the CALL's id, which is
      // the only id anything about this sub-agent is keyed by.
      toolUseId:
        (row.kind === "described" ? row.toolUseId : undefined) ??
        agentToolEvent?.toolUseId ??
        "",
      agentToolEvent,
      taskNotifications,
      requestShape: row.kind === "described" ? row.requestShape : undefined,
      turnEnded: row.turnEnded,
      conversationStatus,
      ...workflowInputs(row),
      ...teammateInputs(row),
      ...resumeInputs(row),
    });
    return {
      row,
      state,
      startedAt: new Date(row.startedAt),
      // The last append is the closest thing to an end time; there is no exit
      // marker on disk. Only meaningful once it has stopped.
      endedAt: state.kind === "running" ? null : new Date(row.lastActivityAt),
      lastStep: row.lastStep,
      agentToolEvent,
    };
  });

  return {
    kind: "known",
    entries,
    agentCalls,
    workflowRuns,
    statusOf: ({ toolUseId, agentToolEvent }) => {
      // The one sanctioned card → row join, which needs BOTH of a sub-agent's
      // keys: one spawned with a name is recorded as an in-process teammate and
      // gets no `toolUseId` at all, so an id-only join leaves its card with no
      // duration, no last step and a button onto a pane that never resolves.
      // The parent's own `Agent` call carries both, and `agentCallJoin` reads
      // them off it.
      //
      // With no such call recorded — a pane reached by an id the parent
      // transcript never held — the id is genuinely all there is, which the
      // join key spells directly rather than inventing a name to look up.
      const row = describedSubagent(
        rows,
        agentToolEvent ? agentCallJoin(agentToolEvent) : { toolUseId },
      );
      const state = subagentRunState({
        toolUseId,
        agentToolEvent,
        taskNotifications,
        requestShape: row?.requestShape,
        turnEnded: row?.turnEnded,
        conversationStatus,
        ...workflowInputs(row),
        ...teammateInputs(row),
        ...resumeInputs(row),
      });
      const startedAt = row?.startedAt ?? agentToolEvent?.at ?? null;
      return {
        kind: "known",
        state,
        row,
        startedAt: startedAt === null ? null : new Date(startedAt),
        endedAt:
          state.kind === "running" || row === undefined
            ? null
            : new Date(row.lastActivityAt),
      };
    },
  };
}
