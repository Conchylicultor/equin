import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { hasLiveProcess } from "@plugins/conversations/core";
import {
  WORKFLOW_TOOL_NAME,
  parseWorkflowResult,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/workflow/core";
import type { SubagentActivityRow } from "./protocol";
import { subagentRunState, type SubagentRunState } from "./run-state";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type TaskNotificationEvent = Extract<JsonlEvent, { kind: "task-notification" }>;

/**
 * The run folder prefix Claude Code gives every workflow run, and that the
 * `Workflow` call's result prints after `Run ID:`. A value without it is not a
 * run id this plugin has ever seen on disk, so it joins nothing.
 */
const RUN_ID_PREFIX = "wf_";

/** Every `Workflow` tool-call in a parent transcript, in transcript order. */
export function workflowCallsIn(
  events: readonly JsonlEvent[],
): ToolCallEvent[] {
  return events.filter(
    (e): e is ToolCallEvent =>
      e.kind === "tool-call" && e.name === WORKFLOW_TOOL_NAME,
  );
}

/**
 * The run a `Workflow` call launched — the `wf_…` folder its agents are
 * written into — read off the call's own result (`Run ID: wf_…`).
 *
 * `undefined` while the result has not landed, when it is an error (nothing
 * was launched), and when it names no run in the shape the folders use.
 * A workflow's call result is an immediate launch receipt, so it lands within
 * a moment of the call; its absence is short-lived.
 */
export function workflowRunIdOf(call: ToolCallEvent): string | undefined {
  const result = call.result;
  if (result === undefined || result.isError === true) return undefined;
  const runId = parseWorkflowResult(result.content).runId;
  return runId?.startsWith(RUN_ID_PREFIX) ? runId : undefined;
}

/**
 * When the run a `Workflow` call launched was stopped by a `TaskStop` of its
 * task id (read off the call's result), or `undefined` when it was not.
 */
function stopTimeOf(
  call: ToolCallEvent,
  stopTimes: Readonly<Record<string, string>>,
): string | undefined {
  const result = call.result;
  if (result === undefined || result.isError === true) return undefined;
  const taskId = parseWorkflowResult(result.content).taskId;
  return taskId === undefined ? undefined : stopTimes[taskId];
}

/**
 * One workflow run, as the conversation's surfaces see it: the parent for the
 * agents it spawned.
 */
export interface WorkflowRunEntry {
  /** The `wf_…` folder name, and what the call's result prints as `Run ID:`. */
  runId: string;
  /** The `Workflow` call naming this run, if it is still in the kept chain. */
  call: ToolCallEvent | undefined;
  state: SubagentRunState;
  /** The call's time, else the earliest of its agents' starts. */
  startedAt: Date;
  /**
   * When it stopped: the run's completion notification, else the `TaskStop`
   * that stopped it, else its latest agent's last write. `null` while running.
   */
  endedAt: Date | null;
}

export interface WorkflowRunsInput {
  /** Every sub-agent row of the conversation; only those with `workflow` are read. */
  rows: readonly SubagentActivityRow[];
  /** `workflowCallsIn` of the parent transcript. */
  workflowCalls: readonly ToolCallEvent[];
  /** Every `task-notification` in the parent transcript. */
  taskNotifications: readonly TaskNotificationEvent[];
  /** `taskStopTimes` of the parent transcript (ISO times), by stopped task id. */
  stopTimes: Readonly<Record<string, string>>;
  conversationStatus: ConversationStatus;
}

/**
 * A workflow agent's state from its OWN evidence alone — its journal line, its
 * turn end, the parent's liveness — before its run's end is known. Used to
 * decide whether a run with no call left to read is still going.
 *
 * Routed through `subagentRunState` so there is still ONE computation: a
 * workflow agent joins no `Agent` call and gets no notification of its own, so
 * those inputs are simply empty.
 */
function ownState(
  row: SubagentActivityRow,
  conversationStatus: ConversationStatus,
): SubagentRunState {
  return subagentRunState({
    toolUseId: "",
    agentToolEvent: undefined,
    taskNotifications: [],
    requestShape: row.kind === "described" ? row.requestShape : undefined,
    turnEnded: row.turnEnded,
    conversationStatus,
    workflowReported: row.workflow?.reported,
  });
}

/**
 * Every workflow run seen on a row, with where it stands — the ONE derivation,
 * so a band's run row and the state each of its agents is given from it cannot
 * disagree.
 *
 * The run's state, in order of authority:
 *
 * - **its completion notification** — a workflow runs in the background, and
 *   its end arrives as the `task-notification` carrying the `Workflow` call's
 *   tool-use id ⇒ finished. (The call's own `tool_result` is only a launch
 *   receipt and means nothing.)
 * - **a successful `TaskStop` of its task** (the `Task ID:` the call's result
 *   prints) ⇒ ended without reporting, at the stop. Claude Code writes no
 *   notification for a run the agent stopped itself, so without this the run —
 *   and every agent in it — reads running for as long as the parent lives.
 * - **no call to read** (scrolled out of the kept chain, or its result has not
 *   landed) ⇒ running exactly while one of its agents is, by that agent's own
 *   evidence; once none is, finished only if every one of them finished.
 * - **otherwise** the parent's liveness: a run is hosted by the parent's
 *   process, so a parent with none left means the run ended without its
 *   notification ever being written.
 *
 * An agent's `workflowRunEnded` input is then `state.kind !== "running"`.
 */
export function workflowRunsOf(input: WorkflowRunsInput): WorkflowRunEntry[] {
  const {
    rows,
    workflowCalls,
    taskNotifications,
    stopTimes,
    conversationStatus,
  } = input;

  const agentsByRun = new Map<string, SubagentActivityRow[]>();
  for (const row of rows) {
    if (row.workflow === undefined) continue;
    const list = agentsByRun.get(row.workflow.runId) ?? [];
    list.push(row);
    agentsByRun.set(row.workflow.runId, list);
  }

  const callByRun = new Map<string, ToolCallEvent>();
  for (const call of workflowCalls) {
    const runId = workflowRunIdOf(call);
    if (runId !== undefined && !callByRun.has(runId)) {
      callByRun.set(runId, call);
    }
  }

  const runs: WorkflowRunEntry[] = [];
  for (const [runId, agents] of agentsByRun) {
    const call = callByRun.get(runId);
    const notification =
      call === undefined
        ? undefined
        : taskNotifications.find((n) => n.toolUseId === call.toolUseId);
    const stoppedAt =
      notification !== undefined || call === undefined
        ? undefined
        : stopTimeOf(call, stopTimes);

    let state: SubagentRunState;
    if (notification !== undefined) {
      state = { kind: "finished" };
    } else if (stoppedAt !== undefined) {
      state = { kind: "ended-without-reporting" };
    } else if (call === undefined) {
      const own = agents.map((row) => ownState(row, conversationStatus).kind);
      state = own.includes("running")
        ? { kind: "running" }
        : own.every((kind) => kind === "finished")
          ? { kind: "finished" }
          : { kind: "ended-without-reporting" };
    } else {
      state = hasLiveProcess(conversationStatus)
        ? { kind: "running" }
        : { kind: "ended-without-reporting" };
    }

    const earliestStart = Math.min(
      ...agents.map((row) => Date.parse(row.startedAt)),
    );
    const latestWrite = Math.max(
      ...agents.map((row) => Date.parse(row.lastActivityAt)),
    );
    runs.push({
      runId,
      call,
      state,
      startedAt: new Date(call?.at ?? earliestStart),
      endedAt:
        state.kind === "running"
          ? null
          : new Date(notification?.at ?? stoppedAt ?? latestWrite),
    });
  }

  return runs.sort(
    (a, b) =>
      a.startedAt.getTime() - b.startedAt.getTime() ||
      a.runId.localeCompare(b.runId),
  );
}
