import type { TaskStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { SLOT_SETTLED_STATUSES } from "../../core";

// The three readings of a task's status the catalog shows, written once: the
// queries in `origin.ts` / `decisions.ts` filter on them, and
// `catalogStatusMoved` tells the status-change job which transitions can move
// the catalog — so the two cannot disagree.

/**
 * The statuses that CLOSE a task an automation filed: until then it is open
 * (`openTaskId`), and the automation files nothing beside it. Held and
 * attempted-without-a-push stay open — they are a person's to look at.
 */
export const FILED_CLOSED_STATUSES = ["done", "dropped"] as const;

/**
 * The one status in which an approved task still waits for a launch-kind
 * automation (`approvedCount`): a done, dropped, held or already-started task
 * waits on no automation.
 */
export const AWAITING_LAUNCH_STATUS = "new" satisfies TaskStatus;

const FILED_CLOSED: ReadonlySet<string> = new Set(FILED_CLOSED_STATUSES);
const SLOT_SETTLED: ReadonlySet<string> = new Set(SLOT_SETTLED_STATUSES);

/** Where a status stands on each of the catalog's readings. */
function catalogReading(status: TaskStatus): string {
  return [
    FILED_CLOSED.has(status),
    SLOT_SETTLED.has(status),
    status === AWAITING_LAUNCH_STATUS,
  ].join();
}

/**
 * Whether a task moving from `previous` to `next` can change what the catalog
 * shows for it: it opens or closes a filing, takes or frees a slot, or starts
 * or stops waiting for a launch. A running agent's turn (`in_progress` ↔
 * `need_action`) moves none of them.
 */
export function catalogStatusMoved(
  previous: TaskStatus,
  next: TaskStatus,
): boolean {
  return catalogReading(previous) !== catalogReading(next);
}
