import { useMemo, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  eventRunIdKind,
  eventSourceRuns,
  type EventSourceRun,
  type EventSourceRunRow,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import { eventSourceRunPane } from "../panes";
import { RunActions } from "../slots";
import { RunRow } from "./run-row";

/**
 * The run ledger, config-backed like every DataView: the view instances live
 * only in `config/apps/events/sources/source-detail/runs/events.source-runs.jsonc`.
 * It IS `eventSourceRuns`' column scope (asserted at mount): the surface whose
 * custom columns sort and filter the live window.
 */
const RUNS_VIEW = defineDataView("events.source-runs");

/**
 * The live source: the `events.source-runs` window, read as live key-range
 * pages (the ledger keeps 30 days, past one window on a short cadence). "Which run said
 * that" is the one thing anyone searches a ledger for, so the search box
 * matches the error and the outcome.
 */
const runsSource = liveDataSource(eventSourceRuns, {
  searchable: ["error", "outcome"],
});

/**
 * Every field is `eventSourceRuns`' — the run entity's, derived — but the
 * source: the ledger is scoped to one source, so a source column would say the
 * same thing on every row.
 */
const RUN_OVERRIDES = fieldOverrides(eventSourceRuns, {
  sourceId: { visible: false },
});

/**
 * The one field the ledger computes itself: the caveats COUNT, not the text.
 * Display-only: `flags` is a jsonb list with no column the server could sort
 * or filter on, and no saved view asks for it. An `unchanged` or `failed` run
 * never extracted anything, so it reads 0 — truthfully.
 */
const RUN_EXTRA_FIELDS: FieldDef<EventSourceRunRow>[] = [
  {
    id: "flags",
    label: "Caveats",
    type: "number",
    value: (r) => r.flags.length,
    align: "end",
  },
];

export function SourceRunsSection({
  sourceId,
}: {
  sourceId: string;
}): ReactNode {
  // This source's runs: its scope, stated as data (never a filter the user's
  // Filter control could name or widen).
  const source = useMemo(
    () => runsSource.scoped({ where: { sourceId } }),
    [sourceId],
  );
  const openPane = useOpenPane();
  // Which run the pane beside this list is showing, so the ledger marks it. Read
  // off the route rather than held here: the pane may equally have been reached
  // by a deep link, and there is only ever one answer to "which run is open".
  const openRunParam = eventSourceRunPane.useRouteEntry()?.params.runId;
  const openRunId =
    openRunParam === undefined ? undefined : eventRunIdKind.key(openRunParam);

  return (
    // Every column is a typed field, so "show me only the failures" is a filter
    // on `outcome` rather than a bespoke chip — including the `unchanged` runs,
    // which are the whole reason a cheap run is recorded at all.
    <DataView<EventSourceRunRow>
      storageKey={RUNS_VIEW}
      source={source}
      overrides={RUN_OVERRIDES}
      extraFields={RUN_EXTRA_FIELDS}
      itemActions={RunActions}
      selectedRowId={openRunId}
      // Clicking the row IS opening the run — the same call the sources list
      // makes. A ledger row is not editable and has no second meaning, so making
      // the drill-in an action would put the pane's whole content behind a
      // hover-revealed button the row body hit-tests over.
      //
      // Both ids, because the run's route chains under the source: the URL is
      // `/events/sources/source/<s>/run/<r>`, so an opener names the whole
      // chain. Here `sourceId` is redundant rather than load-bearing — this card
      // only ever renders inside the source pane, so the source is already the
      // slot to the left and the push inherits it from the route. It is passed
      // because the type asks for the chained set, and because a card that knows
      // which source it is drawing should not be the one deciding that.
      rowActivation={(run) =>
        openPane.to(
          eventSourceRunPane,
          { sourceId, runId: run.id },
          { mode: "push", side: "right" },
        )
      }
      views={["list", "table"]}
      viewOptions={{
        list: {
          size: "sm",
          renderRow: (r: EventSourceRun) => <RunRow run={r} />,
        },
      }}
      emptyState="No runs yet — use Refresh now, or wait for the cadence to come round."
    />
  );
}
