import {
  useLive,
  type LiveListResult,
} from "@plugins/network/plugins/live/web";
import {
  historyVersions,
  type Version,
} from "@plugins/history/plugins/engine/core";

// The newest version of one (sourceId, entityId) — what the dialog previews
// until the user picks a row. A one-row live window of the timeline the
// DataView pages, so a snapshot recorded (or a restore made) while the dialog
// is open moves it without a refetch.
export function useNewestVersion(
  sourceId: string,
  entityId: string,
): LiveListResult<Version> {
  return useLive(historyVersions, {
    where: { sourceId, entityId },
    orderBy: [["createdAt", "desc"]],
    limit: 1,
  });
}
