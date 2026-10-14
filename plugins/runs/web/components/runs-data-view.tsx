import { useCallback, useMemo, type ReactNode } from "react";
import {
  DataView,
  liveDataSource,
  type DataViewDensity,
} from "@plugins/primitives/plugins/data-view/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  afterOpen,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
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
   * Fires when a row is clicked, IN ADDITION to the arm's own
   * `Runs.Kind.link` — never instead of it.
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
  const openPane = useOpenPane();
  const kinds = Runs.Kind.useContributions();

  const openers = useMemo(
    () =>
      new Map(
        kinds.flatMap((k) =>
          k.link ? [[k.arm.owner.arm, k.link] as const] : [],
        ),
      ),
    [kinds],
  );

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

  // Per row, not per surface: this list holds rows of several kinds and only
  // some of them go anywhere. A build row activates and stays a button; a backup
  // row whose arm contributes no `open` resolves to null and renders as a plain
  // container — which is what lets its body hold a real control instead of
  // nesting a <button> inside the row's own.
  //
  // Two independent reasons a click matters (the arm's navigation and the host's
  // own side effect), so a row activates if EITHER is present and runs both when
  // both are. An arm's navigation is a link, so its row stays one (middle- /
  // ⌘-click open the run in a browser tab) with the host's effect folded into
  // the plain click.
  const resolveActivation = useCallback(
    (run: RunRow): Activation | undefined => {
      const linkOf = openers.get(run.kind);
      // No opener: the host's effect alone, which is not navigation — a plain
      // action, with no gesture to honour.
      if (!linkOf) {
        return onRowActivate ? () => onRowActivate(run) : undefined;
      }
      const link = linkOf(run, { openPane });
      return onRowActivate ? afterOpen(link, () => onRowActivate(run)) : link;
    },
    [openers, onRowActivate, openPane],
  );

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
      rowActivation={resolveActivation}
    />
  );
}
