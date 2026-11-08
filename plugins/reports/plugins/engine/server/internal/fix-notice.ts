import type { NotificationState } from "@plugins/shell/plugins/notifications/core";
import type { ReportFixState } from "@plugins/reports/core";

/** A commit as a notification line names it. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 9);
}

/**
 * What a report's notifications say of its fix — the line every row about the
 * report carries (`restateByMetadata`), and what each new bell write stamps.
 * An open report has none.
 */
export function fixNoticeOf(row: {
  fixState: ReportFixState;
  fixCommit: string | null;
}): NotificationState | null {
  if (row.fixState === "open" || row.fixCommit === null) return null;
  const commit = shortCommit(row.fixCommit);
  switch (row.fixState) {
    case "pending":
      return { tone: "pending", text: `Fix on its way: ${commit}` };
    case "fixed":
      return { tone: "resolved", text: `Fixed by ${commit}` };
    case "regressed":
      return { tone: "recurred", text: `Came back after ${commit}` };
  }
}

/**
 * The bell's dedup key for a report: its id, and — once it regressed — its id
 * and the fix that did not hold, so the regression is a NEW row on top and
 * every later occurrence lands on it, while the earlier rows stay where they
 * were (`shell/notifications`' rules).
 */
export function bellKeyOf(row: {
  id: string;
  fixState: ReportFixState;
  fixCommit: string | null;
}): string {
  return row.fixState === "regressed" && row.fixCommit !== null
    ? `${row.id}:regressed:${row.fixCommit}`
    : row.id;
}
