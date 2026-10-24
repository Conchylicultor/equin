import { TRIAGE_PRIORITIES, type TriagePriority } from "./vocabulary";

/** What `compareByTriage` ranks: a task, and the priority its read gave it. */
export interface TriageRankable {
  taskId: string;
  /** When the task was filed. */
  createdAt: Date;
  /**
   * The priority of the read it ranks by (`latestTriageResult(read)?.priority`),
   * `null` for a task with none — ranked after every triaged one.
   */
  priority: TriagePriority | null;
}

const UNTRIAGED_RANK = TRIAGE_PRIORITIES.length;

function priorityRank(p: TriagePriority | null): number {
  return p === null ? UNTRIAGED_RANK : TRIAGE_PRIORITIES.indexOf(p);
}

/**
 * Triage order, best first: priority must → should → could → wont →
 * untriaged, then the oldest filed first, then the task id (a total order, so
 * two lists sorting the same tasks agree). The one comparator every ranking
 * of triaged tasks uses (the autopilot's launch list and its candidates), so
 * they cannot drift.
 */
export function compareByTriage(a: TriageRankable, b: TriageRankable): number {
  return (
    priorityRank(a.priority) - priorityRank(b.priority) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)
  );
}
