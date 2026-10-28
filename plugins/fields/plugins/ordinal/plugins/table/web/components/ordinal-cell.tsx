import type { ReactNode } from "react";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";
import { formatOrdinal } from "@plugins/fields/plugins/ordinal/core";

/** Read-only ordinal cell: the value in the type's one spelling, blank when unset. */
export function OrdinalCell(props: TableCellProps): ReactNode {
  const { value } = props;
  if (value === null || value === undefined) return null;
  if (typeof value !== "number")
    throw new Error(
      `OrdinalCell: field "${props.field.id}" holds ${typeof value}, not a number`,
    );
  return (
    <span className="tabular-nums text-muted-foreground">
      {formatOrdinal(value)}
    </span>
  );
}
