import type { FieldOptionMeta } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { rowKind } from "@plugins/network/plugins/live/core";
import type { LaunchDecision } from "@plugins/tasks/plugins/automations/core";
import {
  compareByTriage,
  latestTriageResult,
  type TriageRead,
  type TriageReadResult,
} from "@plugins/tasks/plugins/task-triage/core";

/**
 * Where a ready sidequest sits in the launch list, in display order:
 *
 * - `approved` — the person approved it: the autopilot may launch it.
 * - `proposed` — triage read it and nothing is left to ask; a checkbox, ticked
 *   for the person when the read is fresh and rates it a low-risk must / should
 *   that is ready (never approved).
 * - `needs-call` — triage put a question to the person, unanswered yet.
 * - `obsolete` — triage found it already fixed or its code gone, or rated it
 *   won't (out of scope this timebox).
 * - `failed` — its only triage run ended without a read.
 * - `triaging` — not read yet: queued, running, or never asked for.
 * - `excluded` — the person excluded it: never proposed until restored.
 */
export const LAUNCH_LANES = [
  "approved",
  "proposed",
  "needs-call",
  "obsolete",
  "failed",
  "triaging",
  "excluded",
] as const;
export type LaunchLane = (typeof LAUNCH_LANES)[number];

/** How each lane presents (the `lane` field's options). */
export const LAUNCH_LANE_META: {
  readonly [L in LaunchLane]: FieldOptionMeta;
} = {
  approved: { label: "Approved" },
  proposed: { label: "Proposed by triage" },
  "needs-call": { label: "Needs your call" },
  obsolete: { label: "Looks obsolete / won't" },
  failed: { label: "Triage failed" },
  triaging: { label: "Triaging" },
  excluded: { label: "Excluded" },
};

/**
 * A launch-list row as every list of it shows it: the sidequest's title, where
 * it stands, its launch order. The rows are joined in the browser from several
 * reads (tasks, triage, the person's decisions), so they are no database data:
 * a row kind, a collection with no server, declared once — the list derives
 * its fields from it. The row also carries the task, triage and decision
 * themselves (`LaunchListRow`), which no list shows as a field.
 */
export const launchListRowKind = rowKind("sidequest-autopilot.launch-list", {
  fields: {
    title: textField({ label: "Sidequest", primary: true }),
    lane: enumTextField(LAUNCH_LANES, {
      label: "Where it stands",
      options: LAUNCH_LANE_META,
    }),
    rank: intField({ label: "Launch order" }),
  },
  carry: { fields: { id: textField() } },
  id: "id",
});

/** A ready sidequest, as the launch list reads it. */
export interface LaunchListTask {
  id: string;
  title: string;
  createdAt: Date;
}

export interface LaunchListRow {
  /** The task's id — the row's. */
  id: string;
  /** The task's title: the kind's primary field. */
  title: string;
  task: LaunchListTask;
  /** The task's triage as task-triage holds it (`null`: never asked for). */
  triage: TriageRead | null;
  /**
   * The read the row is judged by: the latest that landed (`done` / `stale`,
   * or the one a run in flight or failed would replace) — `null` for none.
   */
  result: TriageReadResult | null;
  decision: LaunchDecision | null;
  lane: LaunchLane;
  /** Launch order, 1-based: triage's priority, then oldest first. */
  rank: number;
  /** Ticked for the person before they touch it — never an approval. */
  preTicked: boolean;
}

export function laneOf(
  triage: TriageRead | null,
  decision: LaunchDecision | null,
): LaunchLane {
  if (decision === "approved") return "approved";
  if (decision === "excluded") return "excluded";
  const result = latestTriageResult(triage);
  if (result === null) {
    return triage?.state === "failed" ? "failed" : "triaging";
  }
  if (result.verdict === "obsolete" || result.priority === "wont") {
    return "obsolete";
  }
  if (result.question !== null && result.answer === null) return "needs-call";
  return "proposed";
}

/**
 * Triage's pre-tick: a fresh (`done`) read rating it a ready, low-risk must or
 * should — or, when it put a question, one the person answered. Only ever a
 * suggestion in the list.
 */
export function preTicked(triage: TriageRead | null): boolean {
  if (triage?.state !== "done") return false;
  const read = triage.read;
  if (read.question !== null) return read.answer !== null;
  return (
    read.verdict === "ready" &&
    (read.priority === "must" || read.priority === "should") &&
    read.risk === "low"
  );
}

/**
 * Every ready sidequest as a launch-list row, in launch order (the
 * autopilot's candidates' order: task-triage's `compareByTriage`).
 */
export function launchListRows(
  tasks: readonly LaunchListTask[],
  triage: ReadonlyMap<string, TriageRead>,
  decisions: ReadonlyMap<string, LaunchDecision>,
): LaunchListRow[] {
  const judged = tasks.map((task) => {
    const read = triage.get(task.id) ?? null;
    return { task, read, result: latestTriageResult(read) };
  });
  judged.sort((a, b) =>
    compareByTriage(
      {
        taskId: a.task.id,
        createdAt: a.task.createdAt,
        priority: a.result?.priority ?? null,
      },
      {
        taskId: b.task.id,
        createdAt: b.task.createdAt,
        priority: b.result?.priority ?? null,
      },
    ),
  );
  return judged.map(({ task, read, result }, index) => {
    const decision = decisions.get(task.id) ?? null;
    return {
      id: task.id,
      title: task.title,
      task,
      triage: read,
      result,
      decision,
      lane: laneOf(read, decision),
      rank: index + 1,
      preTicked: preTicked(read),
    };
  });
}
