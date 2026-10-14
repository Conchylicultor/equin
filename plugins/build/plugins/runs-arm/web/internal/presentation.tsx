import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { BuildStatusChip } from "@plugins/build/plugins/build-status/web";
import { buildRunArm } from "../../core";
import { buildOutcomeOf } from "./outcome";

/**
 * How the build arm's fields present in every list of the runs union. Each
 * cell is handed this arm's value — never called on another kind's row, which
 * reads blank — so nothing here checks the kind.
 *
 * The status chip reads the row, not the value: it is the build pane's own
 * chip, deciding from the finished time and exit code exactly as there.
 */
export const buildRunPresentation = FieldPresentation.Register({
  owner: buildRunArm,
  fields: {
    status: {
      cell: (_status, run) => <BuildStatusChip run={buildOutcomeOf(run)} />,
      width: "11rem",
    },
    // Off by default: `label` already IS the joined targets, so the column
    // earns its place only when someone wants to filter one chip out of the
    // list.
    targets: { visible: false, width: "12rem" },
    commitHash: {
      cell: (hash) =>
        hash === null ? null : (
          <Badge variant="muted" mono title={hash}>
            {hash.slice(0, 8)}
          </Badge>
        ),
      visible: false,
      width: "7rem",
    },
    exitCode: { visible: false, width: "6rem" },
  },
});
