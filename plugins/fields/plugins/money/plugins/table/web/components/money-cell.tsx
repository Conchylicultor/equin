import type { ReactNode } from "react";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";
import { formatUsd } from "@plugins/fields/plugins/money/core";

/** Read-only money cell: the value in the type's one spelling, blank when unset. */
export function MoneyCell(props: TableCellProps): ReactNode {
  const { value } = props;
  if (value === null || value === undefined) return null;
  if (typeof value !== "number")
    throw new Error(
      `MoneyCell: field "${props.field.id}" holds ${typeof value}, not a number`,
    );
  return <span className="tabular-nums">{formatUsd(value)}</span>;
}
