import {
  UNGROUPED_FOLD_KEY,
  type DataViewRowEntry,
  type DataViewSection,
  type FilterGroup,
  type FoldLimit,
  type FoldRule,
  type ViewState,
} from "../../core";
import { entryHolds } from "./attach";

/** The fold-line key of a section: its group key, or the ungrouped sentinel. */
export function foldKeyOf(section: { key: string | null }): string {
  return section.key ?? UNGROUPED_FOLD_KEY;
}

/**
 * The fold rule made of a `keep` and a `limit`, either possibly absent: an
 * empty `keep` group is no `keep` (it keeps everything), and with neither left
 * there is no rule — `null`, what `setFold` clears with. The one place the two
 * halves are put together, so editing one never drops the other.
 */
export function foldRuleOf(
  keep: FilterGroup | null | undefined,
  limit: FoldLimit | undefined,
): FoldRule | null {
  if (keep && keep.children.length > 0) {
    return limit === undefined ? { keep } : { keep, limit };
  }
  return limit === undefined ? null : { limit };
}

/**
 * The fold rule actually in effect for a view state: absent while a search is
 * typed, because a search match must never hide behind "…". Uses the same
 * `trim()` test `useFlatRows` applies, so "searching" means one thing.
 */
export function effectiveFold(state: ViewState): FoldRule | undefined {
  return state.query.trim() ? undefined : state.fold;
}

/**
 * Which of a section's entries the fold keeps, in entry order — one flag per
 * entry. Positional, not per entry: `fold.limit` keeps only the first N, so the
 * answer for one entry depends on the entries before it.
 */
export type FoldKeep<TRow> = (
  entries: readonly DataViewRowEntry<TRow>[],
) => boolean[];

/**
 * Build the fold's keep pass the fold step and the host's paging gate share.
 * Walking a section's entries in order, an entry is kept when
 *  - it is the selected row (the row the user has open is never folded away —
 *    an aggregate entry is the selected row when its representative or any of
 *    its members is, a parent when a row attached beneath it is), or
 *  - it matches the fold rule's `keep` (`matchesKeep`: the tree lowered by
 *    `useRowFilter`, the same evaluator the filter uses — `null` when there is
 *    no `keep`, or it constrains nothing, so an incomplete rule keeps everything
 *    exactly as it filters nothing; an aggregate's representative decides,
 *    because that is the row the user sees) AND fewer than `limit` entries are
 *    kept before it.
 *
 * The selected row counts toward the limit: inside it, it takes a slot; past
 * it, it shows anyway, so a section can show `limit + 1` entries.
 */
export function makeFoldKeep<TRow>(
  matchesKeep: ((row: TRow) => boolean) | null,
  opts: {
    limit?: FoldLimit;
    selectedRowId?: string;
    rowKey: (row: TRow) => string;
  },
): FoldKeep<TRow> {
  const { limit, selectedRowId, rowKey } = opts;
  const isSelected = (entry: DataViewRowEntry<TRow>): boolean =>
    selectedRowId !== undefined && entryHolds(entry, selectedRowId, rowKey);
  return (entries) => {
    let kept = 0;
    return entries.map((entry) => {
      const keep =
        isSelected(entry) ||
        ((matchesKeep === null || matchesKeep(entry.row)) &&
          (limit === undefined || kept < limit));
      if (keep) kept++;
      return keep;
    });
  };
}

/**
 * Pure fold step (testable without React), run LAST — after partition, manual
 * order and aggregation — so it counts the entries the user actually sees, and
 * a `limit` keeps the first N in the order they are drawn.
 *
 * Per section: the entries `keep` does not keep are counted into
 * `section.fold.hidden`. While the section's fold line is closed they are pulled
 * from wherever they sort and `entries` keeps only the kept ones (possibly none —
 * the section still renders, header plus fold line); while it is open every
 * entry stays, in sorted order. A section with no folded entry carries no
 * `fold` at all. `count` is never touched: it stays the section's total.
 *
 * A section paging its own read (`section.paging`, a declared section) stops
 * paging while its fold line is closed and its last loaded entry is folded —
 * rule 6 per section: the next page would land behind the line, and the
 * footer's sentinel, still in view, would page the whole read in. Opening the
 * line lifts the hold.
 */
export function foldSections<TRow>(
  sections: DataViewSection<TRow>[],
  opts: {
    keep: FoldKeep<TRow>;
    openKeys: ReadonlySet<string>;
  },
): DataViewSection<TRow>[] {
  return sections.map((section) => {
    const flags = opts.keep(section.entries);
    const kept = section.entries.filter((_, i) => flags[i]);
    const hidden = section.entries.length - kept.length;
    if (hidden === 0) return section;
    const open = opts.openKeys.has(foldKeyOf(section));
    const tailFolded = !open && flags[flags.length - 1] === false;
    return {
      ...section,
      entries: open ? section.entries : kept,
      fold: { hidden, open },
      ...(section.paging && tailFolded
        ? { paging: { ...section.paging, canGrow: false } }
        : {}),
    };
  });
}

/**
 * Whether a server-paged view should stop auto-fetching: the fold is in effect,
 * no fold line is open, and the read's LAST loaded entry is folded. Pages past a
 * folded tail would only land behind "…", so the infinite-scroll sentinel is
 * withheld until the user opens a fold (which brings it back).
 *
 * `entries` are the loaded entries of the tail's section, in order, ending at
 * the tail — the whole section, because a `limit` decides by position.
 */
export function isTailFolded<TRow>(
  entries: readonly DataViewRowEntry<TRow>[],
  opts: {
    fold: FoldRule | undefined;
    openCount: number;
    keep: FoldKeep<TRow>;
  },
): boolean {
  if (!opts.fold || opts.openCount > 0 || entries.length === 0) return false;
  const flags = opts.keep(entries);
  return flags[flags.length - 1] === false;
}

/**
 * The fold rule in words — the fold line's tooltip: "Folding all but the first
 * 10", "Folding all but: Updated is within past 30 days +1", or both ("… the
 * first 10 of: …"). `keep` is the keep tree's `summarizeFilter` summary (null
 * when there is no `keep`, or it constrains nothing); a fold with neither in
 * words has no tooltip.
 */
export function describeFold(
  fold: FoldRule,
  keep: { label: string; more?: number } | null,
): string | undefined {
  const keepText = keep
    ? `${keep.label}${keep.more ? ` +${keep.more}` : ""}`
    : null;
  if (fold.limit === undefined) {
    return keepText ? `Folding all but: ${keepText}` : undefined;
  }
  const first = `Folding all but the first ${fold.limit}`;
  return keepText ? `${first} of: ${keepText}` : first;
}
