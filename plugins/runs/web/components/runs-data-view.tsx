import { useMemo, type ReactNode } from "react";
import {
  DataView,
  liveDataSource,
  type DataViewDensity,
} from "@plugins/primitives/plugins/data-view/web";
import { runRowKey, runs, type RunRow } from "../../core";
import { Runs } from "../internal/slots";
import { RUNS_VIEW } from "../internal/view-id";

/**
 * The live source: the `runs` union window, read as live key-range pages.
 * Everything a
 * person types into the search box is a name or an error — never an id, which
 * would make the box a lookup rather than a search.
 */
const runsSource = liveDataSource(runs, {
  searchable: ["label", "message", "namespace", "trigger"],
});

export interface RunsDataViewProps {
  /** How much room the host gives it — a popover declares `"compact"`. */
  density?: DataViewDensity;
  /** Restrict + order the view children. Defaults to list then table. */
  views?: string[];
  defaultView?: string;
  /**
   * The empty line — REQUIRED, each host's own copy (T12). The surface cannot
   * tell "nothing has ever run" from "nothing matches this view" without a
   * count over every ledger, which no bounded reader has; the host knows which
   * sentence its own scope means.
   */
  emptyState: ReactNode;
  /**
   * Highlight the row whose detail surface is open.
   *
   * The PAIR, never a bare domain id: a run id is unique only within its own
   * ledger, so `{ kind: "build", id }` is what names a row here. A host holding a
   * build run id therefore cannot pass it by accident and get silence — the type
   * makes it say which ledger it means.
   */
  selectedRun?: { kind: string; id: string };
  /**
   * Fires when a row is clicked, IN ADDITION to the arm's own link
   * (`runLinks`) — never instead of it.
   *
   * The arm still owns where the click goes; this is for the host's own business
   * with its own chrome (the build popover closing itself, so it does not hang
   * over the pane the click just opened). It runs after the arm's opener.
   */
  onRowActivate?: (run: RunRow) => void;
  /**
   * Show exactly this view instance, and paint no switcher.
   *
   * Without it, every host of this surface shares one device-local active
   * instance — which is right for the hosts that ARE tab strips over the runs
   * space (the build popover and `/debug/build` deliberately move together), and
   * wrong for a host that is one scoped list inside another app. A pinned host
   * reads its instance and never writes the shared selection.
   */
  pinnedView?: string;
}

/**
 * **Runs** — every long-running operation on this machine, from every ledger, in
 * one list.
 *
 * One ordinary `<DataView>` over the `runs` union window (live key-range
 * pages): the rows arrive already merged, so the host needs to know nothing
 * about arms — and its fields are derived (the base fields from `runs`,
 * presented in `../internal/presentation.tsx`; every arm's from its `liveArm`).
 * Filter, sort and search compile to SQL across every ledger at once, the
 * pages cut across arm boundaries without duplicating or dropping a row,
 * and a write to one ledger refills just the rows it changed.
 *
 * The same component at every density: a build popover and a full debug pane are
 * the same surface asking for different room.
 */
export function RunsDataView({
  density,
  views = ["list", "table"],
  defaultView = "list",
  emptyState,
  selectedRun,
  onRowActivate,
  pinnedView,
}: RunsDataViewProps): ReactNode {
  // No `renderRow`: the row body is the list's own, built from the field schema,
  // so it obeys the view's visible fields. An arm decorates the line with a
  // leading glyph and declares fields (derived from its `liveArm`) — it does
  // not replace the line. See
  // `Runs` in `internal/slots.ts` for why that seam no longer exists.
  const viewOptions = useMemo(
    () => ({
      list: {
        leading: (run: RunRow) => <Runs.Leading.Dispatch run={run} />,
      },
    }),
    [],
  );

  // Where a row goes is its arm's (`runLinks`, applied by every list of runs);
  // a row whose arm registers none stays a plain container. The host's
  // own `onRowActivate` runs after the arm's navigation, on every row.
  return (
    <DataView<RunRow>
      storageKey={RUNS_VIEW}
      source={runsSource}
      views={views}
      defaultView={defaultView}
      pinnedView={pinnedView}
      density={density}
      viewOptions={viewOptions}
      emptyState={emptyState}
      selectedRowId={selectedRun ? runRowKey(selectedRun) : undefined}
      onRowActivate={onRowActivate}
    />
  );
}
