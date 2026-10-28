import type { ReactNode } from "react";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";
import { formatDuration } from "@plugins/fields/plugins/duration/core";

/** Read-only duration cell: the value in the type's one spelling, blank when unset. */
export function DurationCell(props: TableCellProps): ReactNode {
  const { value } = props;
  if (value === null || value === undefined) return null;
  if (typeof value !== "number")
    throw new Error(
      `DurationCell: field "${props.field.id}" holds ${typeof value}, not a number`,
    );
  return <span className="tabular-nums">{formatDuration(value)}</span>;
}
