import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { eventSourceRunsEntityRef } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { formatDuration } from "@plugins/apps/plugins/events/plugins/sources/web";

const COUNT = { align: "end" } as const;

/**
 * How a run's fields present in every list of runs (the source pane's ledger):
 * the counts and the duration right-aligned, the duration in words. Every
 * other field takes its type's cell — `outcome` a chip in its option's tint,
 * `startedAt` a relative time.
 */
export const runPresentation = FieldPresentation.Register({
  owner: eventSourceRunsEntityRef,
  fields: {
    eventsFound: COUNT,
    eventsCreated: COUNT,
    eventsUpdated: COUNT,
    eventsDisappeared: COUNT,
    durationMs: {
      align: "end",
      cell: (ms) => formatDuration(ms) ?? "—",
    },
  },
});
