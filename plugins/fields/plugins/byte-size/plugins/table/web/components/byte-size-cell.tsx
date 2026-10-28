import type { ReactNode } from "react";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";
import { formatByteSize } from "@plugins/fields/plugins/byte-size/core";

/** Read-only byte-size cell: the value in the type's one spelling, blank when unset. */
export function ByteSizeCell(props: TableCellProps): ReactNode {
  const { value } = props;
  if (value === null || value === undefined) return null;
  if (typeof value !== "number")
    throw new Error(
      `ByteSizeCell: field "${props.field.id}" holds ${typeof value}, not a number`,
    );
  return <span className="tabular-nums">{formatByteSize(value)}</span>;
}
