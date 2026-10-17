import type { ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { RunOutcomeChip } from "@plugins/runs/plugins/run-outcome/web";
import { runs } from "../../core";
import { RunDuration } from "../components/run-duration";

// How the `runs` base fields present in every list of runs — registered once
// against the collection (its rows are no entity's), so no host builds them.
// Each arm's own fields are presented by the arm (`owner: arm`). Every base
// field is a column of the union, so every sort and filter compiles to SQL.

function muted(text: string | null): ReactNode {
  return text === null ? null : (
    <span className="text-muted-foreground">{text}</span>
  );
}

export const runsPresentation = FieldPresentation.Register({
  owner: runs,
  fields: {
    label: { width: "minmax(0,1fr)" },
    // The source field: its options (and so its chip) are the registered
    // arms, derived by every list of the union (data-view).
    kind: { width: "8rem" },
    outcome: {
      cell: (outcome) => <RunOutcomeChip outcome={outcome} />,
      width: "10rem",
    },
    trigger: { cell: (trigger) => muted(trigger), width: "8rem" },
    namespace: {
      cell: (namespace) =>
        namespace === null ? null : (
          <Badge variant="muted" mono tooltip={namespace}>
            {namespace}
          </Badge>
        ),
      width: "10rem",
    },
    duration: {
      // Sortable and filterable BECAUSE it is a real projected column, derived
      // in SQL rather than in the cell — so "the ten slowest runs" is a sort,
      // not a thing you can only eyeball on the loaded page. It is
      // finished-only (NULL while running, so a running run sorts last by
      // "Took"); the cell ticks a running run's elapsed time itself.
      cell: (_duration, run) => (
        <span className="text-muted-foreground">
          <RunDuration run={run} />
        </span>
      ),
      width: "6rem",
    },
    startedAt: {
      cell: (startedAt) => (
        <span className="text-muted-foreground">
          <RelativeTime date={startedAt} />
        </span>
      ),
      width: "8rem",
    },
    finishedAt: {
      cell: (finishedAt) =>
        finishedAt === null ? null : (
          <span className="text-muted-foreground">
            <RelativeTime date={finishedAt} />
          </span>
        ),
      // Off by default: `Started` plus `Took` already say when and how long,
      // and a third time column earns its place only when asked for.
      visible: false,
      width: "8rem",
    },
    message: {
      // No `cell` of its own, deliberately: one rendering `whitespace-pre-wrap`
      // is the single thing that can break a row's line (the list's one-line
      // shape is a `region-line` context where every leaf ellipsizes); the
      // shared `TextCell` truncates, which is what a row wants.
      //
      // Off by default, like `finishedAt`: the only prose in a schema of
      // badges and scalars, non-null on just two of the four arms, and the
      // failure is already stated by `outcome` and the arms' own columns. The
      // runs source still searches it.
      visible: false,
      width: "24rem",
    },
  },
});
