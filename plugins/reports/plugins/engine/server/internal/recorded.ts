import { ReportRecorded } from "@plugins/reports/server";

/**
 * Tell every {@link ReportRecorded} listener that `row` was written — when it
 * is one nobody is investigating: no task linked, not noise. The one gate,
 * shared by the two writes that can put a report on the worklist: an
 * occurrence (`recordReport`) and a regression, which unlinks the task of the
 * fix that did not hold (`deriveReportFixState`). The regressing occurrence
 * itself is judged off the write path, after its row was written with the
 * task still linked — so without the second call a regression, the most
 * newsworthy occurrence a report has, would reach no listener.
 */
export function announceRecorded(row: {
  id: string;
  taskId: string | null;
  noise: boolean;
}): void {
  if (row.taskId !== null || row.noise) return;
  for (const l of ReportRecorded.getContributions()) l.onRecorded(row.id);
}
