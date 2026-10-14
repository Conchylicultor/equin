/**
 * The run ledger's fields, derived from the `event_source_runs` entity: the
 * ids the ledger (and its saved views) named before are unchanged, `sourceId`
 * is filterable (the source pane scopes the window by it), and the outcome
 * presents as the run's chip.
 *
 * Run: `./singularity test plugins/apps/plugins/events/plugins/events-core/core`.
 */

import { expect, test } from "bun:test";
import { eventSourceRuns } from "./resources";

test("the run ledger derives its field ids from the run entity", () => {
  expect(Object.keys(eventSourceRuns.fields)).toEqual([
    "startedAt",
    "outcome",
    "eventsFound",
    "eventsCreated",
    "eventsUpdated",
    "eventsDisappeared",
    "durationMs",
    "error",
    "sourceId",
  ]);
  expect(eventSourceRuns.fields.startedAt).toMatchObject({
    label: "Started",
    primary: true,
  });
  expect(eventSourceRuns.fields.outcome.options).toMatchObject({
    failed: { label: "Failed", variant: "destructive" },
  });
  expect(eventSourceRuns.filterable.sourceId.domain).toBe("text");
  expect(eventSourceRuns.columnScope).toBe("events.source-runs");
});
