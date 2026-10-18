import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { HOLD_CLASSES } from "@plugins/infra/plugins/jobs/core";
import { rowKind } from "@plugins/network/plugins/live/core";

/**
 * Every status a row of the Jobs list can be in: graphile's four queue states
 * for a row still in the queue, a recorded run's outcome for a finished one.
 */
export const JOB_LIST_STATUSES = [
  "pending",
  "running",
  "retrying",
  "dead",
  "succeeded",
  "failed",
  "suspended",
] as const;

/**
 * What is wrong with a running queue row, when something is:
 * - `no-worker` — nobody holds the job's advisory lock any more (the owning
 *   backend died, or dispatch is inside its sub-second acquisition window);
 *   the stuck-lock sweeper will reclaim the row.
 * - `forfeited` — the opposite: a worker IS still there, it passed its hold
 *   class's deadline, ignored the abort, and the pool stopped counting its
 *   slot. The row is untouched and its lock still held.
 */
export const JOB_PROBLEMS = ["no-worker", "forfeited"] as const;

/**
 * One row of Debug → Queue's Jobs list: a live graphile queue row or a finished
 * run, merged on the client (`useJobRows`) — rows of two sources, so no table
 * and no collection; a row kind declares the fields every such row shares, once.
 * The rows carry more than these (the queue row or run each came from, what is
 * needed to open it): the list's cells read them.
 *
 * The status, problem, job and hold options are read in the browser
 * (`FieldPresentation`): the queue's own registry is server-side.
 */
export const jobListRow = rowKind("debug.queue.job-row", {
  fields: {
    status: enumTextField(JOB_LIST_STATUSES, { label: "Status" }),
    // Filter-only: the problem badges already show in the status cell.
    problem: nullable(enumTextField(JOB_PROBLEMS, { label: "Problem" })),
    jobName: textField({ label: "Job", primary: true }),
    hold: nullable(enumTextField(HOLD_CLASSES, { label: "Hold" })),
    attempt: intField({ label: "Try" }),
    when: dateField({ label: "When" }),
    waitMs: nullable(intField({ label: "Waited" })),
    durationMs: nullable(intField({ label: "Duration" })),
    error: nullable(textField({ label: "Error" })),
    // The default order: in-flight rows first (oldest first), then finished
    // ones newest first. Sort-only.
    order: intField({ label: "In flight first", filterable: false }),
  },
  carry: { fields: { key: textField() } },
  id: "key",
});
