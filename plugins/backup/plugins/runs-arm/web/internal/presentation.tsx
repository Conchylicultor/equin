import type { ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { backupRunArm } from "../../core";
import { backupArchiveSize } from "./payload";
import { formatBytes } from "./format-bytes";

/** A number column reads as nothing where a run has none, never as zero. */
function numberCell(
  value: number | null,
  render: (n: number) => string,
): ReactNode {
  return value === null ? null : (
    <span className="text-muted-foreground">{render(value)}</span>
  );
}

/**
 * How the backup arm's fields present in every list of the runs union. A cell
 * is handed this arm's value only; on another kind's row it is blank.
 *
 * Three of the four default to hidden. They are dimensions first: "backups whose
 * archive is over a gigabyte" is a filter that compiles to SQL across the whole
 * ledger, and a column blank on three kinds out of four does not earn a
 * permanent place in a mixed table.
 *
 * `archiveSize` is the one that does earn it, and the reason is not that it is
 * more interesting — it is that it is the only fact a backup row otherwise
 * carries nowhere. "Succeeded" says the archive was written; it does not say
 * whether it holds a gigabyte or forty bytes, and a nightly backup that
 * quietly halves is a source that stopped contributing. `outcome` cannot report
 * that and the label does not carry it. The three it sits beside are each
 * answered better elsewhere: the native status is `outcome` at a finer grain,
 * and the two counts are the headline of the Sources and Targets sections in the
 * detail pane, which name them rather than counting them.
 *
 * `status` is the native status kept beside the shared `outcome`. The two are
 * not redundant: `outcome` is the axis a person filters by across every kind,
 * and this is the precision that would otherwise be lost to it.
 */
export const backupRunPresentation = FieldPresentation.Register({
  owner: backupRunArm,
  fields: {
    status: {
      cell: (status) => <Badge variant="muted">{status}</Badge>,
      visible: false,
      width: "8rem",
    },
    archiveSize: {
      // The same accessor the detail pane's Archive line reads, so the column
      // and the line cannot disagree about the run's size.
      cell: (_size, run) => numberCell(backupArchiveSize(run), formatBytes),
      width: "7rem",
    },
    sourceCount: {
      cell: (n) => numberCell(n, String),
      visible: false,
      width: "6rem",
    },
    targetCount: {
      cell: (n) => numberCell(n, String),
      visible: false,
      width: "6rem",
    },
  },
});
