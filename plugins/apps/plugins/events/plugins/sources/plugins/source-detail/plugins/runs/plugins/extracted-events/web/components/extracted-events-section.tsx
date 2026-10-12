import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  useEventSourceRun,
  useRunEvents,
} from "@plugins/apps/plugins/events/plugins/events-core/web";
import {
  RUN_EVENT_ACTIONS,
  type EventSourceRun,
  type RunEvent,
  type RunEventAction,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import {
  EventRow,
  useOpenEvent,
} from "@plugins/apps/plugins/events/plugins/event-list/web";
import { EVENT_CATEGORY_OPTIONS } from "@plugins/apps/plugins/events/plugins/event-list/core";

/**
 * The run's own events DataView, config-backed like every other: the view
 * instances live only in
 * `config/apps/events/sources/source-detail/runs/extracted-events/events.run-events.jsonc`.
 */
const RUN_EVENTS_VIEW = defineDataView("events.run-events");

/** Stable identity for the loading render, so the row pipeline does not churn. */
const EMPTY_EVENTS: RunEvent[] = [];

// Display metadata for what a run did to an event. Local to this plugin because
// this section is the only surface that renders the distinction; promote it to
// `sources`' shared format module the day a second one needs it.
//
// "Gone" rather than "Disappeared": the label sits in a chip on a dense row, and
// what the reader needs is the outcome, not the vocabulary term.
const ACTION_LABEL: Record<RunEventAction, string> = {
  created: "New",
  updated: "Updated",
  disappeared: "Gone",
};

const ACTION_VARIANT: Record<RunEventAction, BadgeVariant> = {
  created: "success",
  updated: "muted",
  // Not `destructive`: an event dropping off a page is the ordinary end of its
  // life, not a fault. Warning is the honest weight — worth noticing, and the
  // one thing on this list that removed something the user could see.
  disappeared: "warning",
};

const ACTION_OPTIONS = RUN_EVENT_ACTIONS.map((a) => ({
  value: a,
  label: ACTION_LABEL[a],
}));

/**
 * What this run did to the event, as the row's LEADING slot. It sits beside the
 * row body rather than inside it, so the body stays byte-identical to the main
 * events list's — one rendering of "an event", with a marker in front.
 */
function ActionChip({ action }: { action: RunEventAction }): ReactElement {
  return <Badge variant={ACTION_VARIANT[action]}>{ACTION_LABEL[action]}</Badge>;
}

/**
 * The section exists for every run, including the ones that touched nothing:
 * "this run changed no events" is an answer, and a card that appeared only when
 * non-empty would leave the reader unable to tell it from a card that had not
 * loaded yet.
 */
export function useExtractedEventsAvailable(): boolean {
  return true;
}

/**
 * Empty is never one fact here, so it is never one sentence.
 *
 * The last arm is the one that matters: a run whose counts say it touched events
 * while its list is empty is NOT "an extraction that found nothing" — it ran
 * before the app kept the per-event record, and that information no longer
 * exists to show. Wording it as emptiness would have the card flatly contradict
 * the counts an inch above it.
 */
function emptyStateFor(run: EventSourceRun | undefined): string {
  if (run === undefined) return "No events.";
  if (run.outcome === "unchanged") {
    return "Nothing was extracted: the page's fingerprint had not moved, so this run skipped extraction entirely.";
  }
  if (run.outcome === "failed") {
    return "This run failed before it wrote anything — see the error on the summary above.";
  }
  const touched =
    run.eventsFound +
    run.eventsCreated +
    run.eventsUpdated +
    run.eventsDisappeared;
  if (touched > 0) {
    return "This run recorded how many events it touched, but not which ones — it ran before the app kept the per-event record, so the list cannot be reconstructed.";
  }
  return "This extraction listed no events at all — the page it read had none the extractor could recognize.";
}

export function ExtractedEventsSection({
  runId,
}: {
  runId: string;
}): ReactNode {
  const query = useRunEvents(runId);
  // Only to word the empty state truthfully — an `unchanged` run touching
  // nothing is the cache working, which is a different sentence from an
  // extraction that ran and changed nothing.
  const row = useEventSourceRun(runId);
  const openEvent = useOpenEvent();

  const fields = useMemo<FieldDef<RunEvent>[]>(
    () => [
      {
        id: "title",
        label: "Title",
        type: "text",
        primary: true,
        value: (e) => e.title,
      },
      // A full dimension, not a decoration: "show me only what this run added"
      // is then a filter on a typed field, and group-by lands the three buckets
      // without this section growing a bespoke control.
      {
        id: "action",
        label: "Change",
        type: "enum",
        options: ACTION_OPTIONS,
        value: (e) => e.action,
      },
      { id: "startsAt", label: "When", type: "date", value: (e) => e.startsAt },
      {
        id: "category",
        label: "Category",
        type: "enum",
        options: EVENT_CATEGORY_OPTIONS,
        value: (e) => e.category,
      },
      { id: "venue", label: "Venue", type: "text", value: (e) => e.venue },
      { id: "city", label: "City", type: "text", value: (e) => e.city },
    ],
    [],
  );

  // The rows only reach the view once the read is ready (`readiness`): a
  // failed fetch renders its failure with Retry, never an eternal skeleton —
  // "the list is unreachable" and "this run touched nothing" are different
  // answers.
  const events = foldResource(query, {
    loading: () => EMPTY_EVENTS,
    error: () => EMPTY_EVENTS,
    ready: (rows) => rows,
  });
  // Only a found run words the empty state; loading, failed or absent fall back
  // to the plain sentence (the summary above and the pane's resolve own those).
  const run = row.status === "ready" && row.found ? row.row : undefined;

  return (
    <DataView<RunEvent>
      storageKey={RUN_EVENTS_VIEW}
      rows={events}
      fields={fields}
      rowKey={(e) => e.id}
      views={["list", "table"]}
      readiness={query}
      // The same destination the main events list opens: the event's own page,
      // else the page it was extracted from.
      onRowActivate={openEvent}
      viewOptions={{
        list: {
          size: "md",
          leading: (e: RunEvent) => <ActionChip action={e.action} />,
          renderRow: (e: RunEvent) => <EventRow event={e} />,
        },
      }}
      emptyState={emptyStateFor(run)}
    />
  );
}
