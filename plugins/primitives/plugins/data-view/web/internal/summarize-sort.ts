import type { FieldDef, SortRule } from "../../core";
import type { DataViewControlSummary } from "../slots";

/**
 * What the closed Sort control says — in its trigger's tooltip + accessible name,
 * and as the compact fold's row text: the top sort level, plus how many further
 * levels there are.
 *
 * Dangling rules — a `fieldId` the active schema no longer carries, after a
 * removed custom column or a switch between merged sources — are dropped with
 * exactly the predicate `SortController.ruleCount` uses, so the summary and the
 * count agree by construction. A rule that sorts nothing must not be described:
 * "Title ↑ +1" where the +1 is a field that no longer exists is a lie about what
 * the user is looking at.
 *
 * The label leans on an arrow because the fold's row gives it one line; `spoken`
 * is what a screen reader gets instead, since "↑" reads as nothing useful.
 *
 * A pinned top level (see `pinned-sort.ts`) is marked with a pin glyph — "📌
 * Folders ↑ +1" — so the summary does not read as if the header the user just
 * clicked were ignored: the pin sorts first, their rule is the "+1".
 *
 * Pure: it takes state, never hooks (see `DataViewControlContribution.summary`).
 */
export function summarizeSort(
  rules: SortRule[],
  sortableFields: FieldDef<unknown>[],
): DataViewControlSummary | null {
  const live = rules.filter((r) =>
    sortableFields.some((f) => f.id === r.fieldId),
  );
  const first = live[0];
  if (!first) return null;

  const field = sortableFields.find((f) => f.id === first.fieldId);
  if (!field) return null;

  const ascending = first.direction === "asc";
  return {
    label: `${first.pinned ? "📌 " : ""}${field.label} ${ascending ? "↑" : "↓"}`,
    spoken: `${field.label}, ${ascending ? "ascending" : "descending"}${first.pinned ? ", pinned" : ""}`,
    more: live.length - 1,
  };
}
