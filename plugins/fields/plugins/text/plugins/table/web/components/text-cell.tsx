import type { ReactNode } from "react";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";

/**
 * Read-only text cell: the value as a bare text run. Whether it stays on one
 * line is its container's call, not the cell's — a table cell, a list row or
 * a card's title line truncates it; a card's clamped subtitle or excerpt
 * wraps it.
 */
export function TextCell(props: TableCellProps): ReactNode {
  return String(props.value ?? "");
}
