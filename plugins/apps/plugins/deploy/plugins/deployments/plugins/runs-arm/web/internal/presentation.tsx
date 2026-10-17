import type { ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { deployRunArm } from "../../core";

/** An id column reads as a monospace chip. */
function idCell(value: string | null): ReactNode {
  return value === null ? null : (
    <Badge variant="muted" mono tooltip={value}>
      {value}
    </Badge>
  );
}

/**
 * How the deploy arm's fields present in every list of the runs union. A cell
 * is handed this arm's value only; on another kind's row it is blank.
 *
 * Everything defaults to hidden. These are dimensions first — "every run that
 * touched this box", "everything that shipped this release" — and a column blank
 * on three kinds out of four does not earn a permanent place in a mixed table.
 */
export const deployRunPresentation = FieldPresentation.Register({
  owner: deployRunArm,
  fields: {
    verb: {
      cell: (verb) => <Badge variant="muted">{verb}</Badge>,
      visible: false,
      width: "7rem",
    },
    phaseFailed: {
      cell: (phase) =>
        phase === null ? null : <Badge variant="destructive">{phase}</Badge>,
      visible: false,
      width: "8rem",
    },
    compositionId: { visible: false, width: "10rem" },
    serverId: { cell: idCell, visible: false, width: "12rem" },
    deploymentId: { cell: idCell, visible: false, width: "12rem" },
    commitSha: {
      // Short in the cell, whole in the tooltip and in the filter — the value
      // is untouched, so a search for a full sha still matches.
      cell: (sha) =>
        sha === null ? null : (
          <Badge variant="muted" mono tooltip={sha}>
            {sha.slice(0, 8)}
          </Badge>
        ),
      visible: false,
      width: "8rem",
    },
    releaseRunId: { cell: idCell, visible: false, width: "12rem" },
    exitCode: { visible: false, width: "6rem" },
  },
});
