import type { TableViewOptions } from "../../core";

/**
 * Whether the table draws its column labels, as `DataTable`'s `header`: the
 * instance's Column captions choice (`columnCaptions`, user-authored) when it
 * is `shown` / `hidden`, else the code's `header`, else `undefined` — the
 * data-table's own default for the presentation (`grid` / `soft` yes,
 * `outline` no). One resolution for the flat and the nested table.
 */
export function tableHeaderOption(
  options: Pick<TableViewOptions, "columnCaptions" | "header">,
): boolean | undefined {
  switch (options.columnCaptions) {
    case "shown":
      return true;
    case "hidden":
      return false;
    case "auto":
    case undefined:
      return options.header;
  }
}
