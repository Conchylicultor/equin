import type { FieldOptionMeta } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { rowKind } from "@plugins/network/plugins/live/core";
import type { LaunchDecision } from "@plugins/tasks/plugins/automations/core";
import {
  triageScore,
  triageStaleness,
  type SidequestTriage,
  type TriageStaleness,
} from "./triage";

/**
 * Where a ready sidequest sits in the launch list, in display order:
 *
 * - `approved` — the person approved it: the autopilot may launch it.
 * - `proposed` — triage read it and nothing is left to ask; a checkbox, ticked
 *   for the person when triage rates it ready and low risk (never approved).
 * - `needs-call` — triage put a question to the person, unanswered yet.
 * - `obsolete` — triage found it already fixed, or its code gone.
 * - `triaging` — not read yet.
 * - `excluded` — the person excluded it: never proposed until restored.
 */
export const LAUNCH_LANES = [
  "approved",
  "proposed",
  "needs-call",
  "obsolete",
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
  obsolete: { label: "Looks obsolete" },
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
  description: string | null;
  createdAt: Date;
}

export interface LaunchListRow {
  /** The task's id — the row's. */
  id: string;
  /** The task's title: the kind's primary field. */
  title: string;
  task: LaunchListTask;
  triage: SidequestTriage | null;
  decision: LaunchDecision | null;
  lane: LaunchLane;
  /** Launch order, 1-based: triage's value for size, then oldest first. */
  rank: number;
  staleness: TriageStaleness | null;
  /** Ticked for the person before they touch it — never an approval. */
  preTicked: boolean;
}

export function laneOf(
  triage: SidequestTriage | null,
  decision: LaunchDecision | null,
): LaunchLane {
  if (decision === "approved") return "approved";
  if (decision === "excluded") return "excluded";
  if (triage === null) return "triaging";
  if (triage.verdict === "obsolete") return "obsolete";
  if (triage.question !== null && triage.answer === null) return "needs-call";
  return "proposed";
}

/**
 * Triage's pre-tick: a fresh read rating it ready and low risk, or a question
 * the person answered. Only ever a suggestion in the list.
 */
export function preTicked(
  triage: SidequestTriage | null,
  staleness: TriageStaleness | null,
): boolean {
  if (triage === null || staleness?.stale === true) return false;
  if (triage.question !== null) return triage.answer !== null;
  return triage.verdict === "ready" && triage.risk === "low";
}

/**
 * Every ready sidequest as a launch-list row, in launch order (the same order
 * the autopilot's candidates use).
 */
export function launchListRows(
  tasks: readonly LaunchListTask[],
  triage: ReadonlyMap<string, SidequestTriage>,
  decisions: ReadonlyMap<string, LaunchDecision>,
  now: Date,
  staleAfterDays: number,
): LaunchListRow[] {
  const ordered = [...tasks].sort(
    (a, b) =>
      triageScore(triage.get(b.id)) - triageScore(triage.get(a.id)) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  return ordered.map((task, index) => {
    const read = triage.get(task.id) ?? null;
    const decision = decisions.get(task.id) ?? null;
    const staleness =
      read === null ? null : triageStaleness(read, task, now, staleAfterDays);
    return {
      id: task.id,
      title: task.title,
      task,
      triage: read,
      decision,
      lane: laneOf(read, decision),
      rank: index + 1,
      staleness,
      preTicked: preTicked(read, staleness),
    };
  });
}
