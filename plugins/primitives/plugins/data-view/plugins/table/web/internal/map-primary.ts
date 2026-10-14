import type { SortState as TableSortState } from "@plugins/primitives/plugins/data-table/web";
import type { SortRule } from "@plugins/primitives/plugins/data-view/web";

/**
 * Map the data-view PRIMARY sort rule onto data-table's single-column sort
 * indicator. The primary is the first USER rule — the one a header click cycles
 * (`cyclePrimarySort`); a pinned prefix sorts ahead of it but is not what the
 * headers drive. Secondary rules don't paint a header arrow (the sort popover is
 * the full multi-sort surface); the data-table primitive stays single-sort.
 */
export function mapPrimary(rules: readonly SortRule[]): TableSortState | null {
  const p = rules.find((r) => !r.pinned);
  return p ? { columnId: p.fieldId, direction: p.direction } : null;
}
