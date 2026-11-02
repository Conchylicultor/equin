import type { ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useEventSourceRun } from "@plugins/apps/plugins/events/plugins/events-core/web";
import { eventsApp } from "@plugins/apps/plugins/events/plugins/shell/core";
import {
  eventRunIdKind,
  type EventSourceRun,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import type { LiveRowResult } from "@plugins/network/plugins/live/web";
import {
  RUN_OUTCOME_LABEL,
  RUN_OUTCOME_VARIANT,
  describeRun,
  formatDuration,
  eventSourceDetailRoute,
} from "@plugins/apps/plugins/events/plugins/sources/web";
import { EventSourceRunDetail } from "./slots";

/**
 * One run: `/events/sources/source/:sourceId/run/:runId`.
 *
 * Chaining to `eventSourceDetailRoute` is what puts the source in the URL, and
 * what types an opener's params as the full `{ sourceId, runId }`. Today the one
 * opener is the runs section inside the source pane, so the source slot is
 * already to its left and the push inherits it; the chained param it passes is
 * spare. A caller holding no source route of its own would have to open with
 * `mode: "root"`, which is the path that reads the supplied `sourceId` and
 * builds the chain from scratch — nothing does that yet.
 *
 * The run is still read by its OWN id (the `events.source-runs` point sibling,
 * `useLive(c, { id })`) rather than reached through the source's runs list, and that is
 * unrelated to the chain: a deep link must resolve from the URL alone, not from
 * whatever window the parent's list happens to have loaded. (`useParams()` stays own-only, so
 * this pane reads `runId`; the source id stays the source pane's to read.)
 *
 * `run/` is globally distinct after param-name erasure — segments are matched
 * across the whole app and param names do not disambiguate. `rg 'segment: "run'`
 * finds nothing else; the nearby `r/:runId` (build) and `rel/:runId` (Studio
 * release) are why the noun is spelled in full, the same call
 * `deploy/deployments` makes with `dep/:deploymentId`.
 *
 * `titleOwner` is deliberately NOT set — the source page keeps the tab title; a
 * run is a drill-in under it, not a new main surface.
 */
export const eventSourceRunPane = Pane.define({
  route: defineRoute({
    id: "event-source-run",
    segment: "run/:runId",
    parent: eventSourceDetailRoute,
  }),
  app: eventsApp,
  component: EventSourceRunPaneView,
  useResolve: useResolveRun,
  title: { useText: useRunTitle, fallback: "Run" },
  width: 460,
});

function useResolveRun({ runId }: { runId: string }): ResolveResult {
  // The by-id row read, arm for arm: a determinately absent run (swept by
  // retention, or its source deleted) is a stale route; a failed read is the
  // error arm with Retry, never a Not Found that would discard a deep link.
  return resolveRow(useEventSourceRun(runId));
}

/**
 * The run the pane is showing, if any: the fresh row, or — on a failed read
 * that already saw it — the last-seen one (the resolve hook keeps the pane up
 * on it). The title and the summary both read this, so they cannot disagree
 * about whether there is a run on screen.
 */
function shownRun(
  row: LiveRowResult<EventSourceRun>,
): EventSourceRun | undefined {
  switch (row.status) {
    case "loading":
      return undefined;
    case "error":
      return row.stale;
    case "ready":
      return row.found ? row.row : undefined;
  }
}

/** The outcome — how a person picks one run out of a ledger. */
function useRunTitle({ runId }: { runId: string }): string | undefined {
  const run = shownRun(useEventSourceRun(runId));
  return run && `${RUN_OUTCOME_LABEL[run.outcome]} run`;
}

function EventSourceRunPaneView(): ReactNode {
  // `key` upgrades a pre-rewrite bare-uuid URL, so every section reads the
  // stored `evrun-` id (the model-call section correlates by it).
  const runId = eventRunIdKind.key(eventSourceRunPane.useParams().runId);
  const row = useEventSourceRun(runId);

  // The summary is the pane's own header block, not a section: it is the run
  // itself, and the sections below are what OTHER plugins have to say about it.
  // Sections render while the read is still in flight — each owns its own
  // loading state, so the pane does not stall behind one gate.
  return (
    <PaneChrome pane={eventSourceRunPane}>
      <Stack gap="none">
        <Inset x="lg" t="lg">
          <RunSummaryArm row={row} />
        </Inset>
        <EventSourceRunDetail.Host runId={runId} />
      </Stack>
    </PaneChrome>
  );
}

/**
 * The summary, arm by arm. A failed read that still holds the run as last seen
 * keeps painting it (the resolve hook already let the pane in on it); one that
 * never saw it says why. Absent never reaches here — the resolve hook turns it
 * into the pane's own Not Found.
 */
function RunSummaryArm({
  row,
}: {
  row: LiveRowResult<EventSourceRun>;
}): ReactNode {
  const run = shownRun(row);
  if (run !== undefined) return <RunSummary run={run} />;
  switch (row.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return <Placeholder tone="error">{row.error.message}</Placeholder>;
    case "ready":
      return null;
  }
}

function SummaryField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Line className="gap-sm">
      <Text variant="label">{label}</Text>
      <Fill />
      <Text variant="caption" tone="muted">
        {children}
      </Text>
    </Line>
  );
}

function RunSummary({ run }: { run: EventSourceRun }): ReactNode {
  const duration = formatDuration(run.durationMs);
  return (
    <Stack gap="sm">
      <Line className="gap-sm">
        <Badge variant={RUN_OUTCOME_VARIANT[run.outcome]}>
          {RUN_OUTCOME_LABEL[run.outcome]}
        </Badge>
        <Fill>
          <Text variant="caption" tone="muted">
            {describeRun(run)}
          </Text>
        </Fill>
      </Line>

      <SummaryField label="Started">
        <RelativeTime date={run.startedAt} />
      </SummaryField>
      <SummaryField label="Duration">
        {duration ?? "Still running"}
      </SummaryField>
      <SummaryField label="Found">{run.eventsFound}</SummaryField>
      <SummaryField label="New">{run.eventsCreated}</SummaryField>
      <SummaryField label="Updated">{run.eventsUpdated}</SummaryField>
      <SummaryField label="Gone">{run.eventsDisappeared}</SummaryField>
      <SummaryField label="Fingerprint">
        {run.fingerprint ? `${run.fingerprint.slice(0, 12)}…` : "None"}
      </SummaryField>

      {/* Verbatim, never summarized away: on a failed run this IS the answer,
          and the ledger row only had room for its first line. */}
      {run.error && (
        <Stack gap="2xs">
          <Text as="p" variant="label" tone="destructive">
            Error
          </Text>
          <Text
            as="p"
            variant="caption"
            tone="destructive"
            className="break-words"
          >
            {run.error}
          </Text>
        </Stack>
      )}
    </Stack>
  );
}
