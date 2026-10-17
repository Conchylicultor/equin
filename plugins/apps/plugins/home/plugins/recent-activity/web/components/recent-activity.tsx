import type { ReactNode } from "react";
import { ActivityDataView } from "@plugins/activity/web";

/**
 * Under the app grid: what was last worked on, of every kind — tasks,
 * conversations, pages — newest first, each row opening its record in its own
 * app.
 */
export function RecentActivity(): ReactNode {
  return (
    <ActivityDataView
      title="Recent activity"
      emptyState="Nothing has been worked on yet."
    />
  );
}
