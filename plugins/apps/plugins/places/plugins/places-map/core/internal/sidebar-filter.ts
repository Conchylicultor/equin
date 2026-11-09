import {
  filterNodeIdKind,
  type FilterGroup,
  type FilterNode,
  type FilterRule,
} from "@plugins/primitives/plugins/data-view/core";
import {
  isTagUnder,
  tagPath,
  type TagNode,
} from "@plugins/tag-tree/plugins/engine/core";

// The tag sidebar's half of the view filter. The view's filter tree is the one
// source of truth; the sidebar owns exactly the TOP-LEVEL rules of an `and`
// root on the tags field with the nested operators, and leaves every other
// rule and group untouched. Its state is an AND of OR-rows:
//
//   each include row → one `has-nested` rule holding the row's tags (or)
//   the rows         → AND-ed, as siblings under the `and` root
//   exclude          → ONE `lacks-nested` rule holding every excluded tag
//
// So the advanced filter builder shows the same rules ("Tags has any of (incl.
// nested) …") and a rule the user writes there with these operators at the top
// level is the sidebar's to show and edit. A row click only includes; an
// exclusion is written in the advanced filter (the sidebar shows it, and a
// click or its chip's × drops it). The filters the older any / all switch
// wrote read back unchanged: "any" was one rule (one row), "all" one rule per
// tag (single-tag rows).

/** The places field id the sidebar's rules test. */
export const TAGS_FIELD_ID = "tags";
/** "Has any of these, or anything nested under them." */
export const HAS_NESTED = "has-nested";
/** "Has none of these, nor anything nested under them." */
export const LACKS_NESTED = "lacks-nested";

/**
 * What the sidebar shows: a place passes when it carries a tag (or a tag
 * nested under it) of EVERY row, and none of the excluded tags. A tag appears
 * at most once across the rows and the exclude list; no row is empty.
 */
export interface SidebarState {
  rows: string[][];
  exclude: string[];
}

/** Nothing picked. */
export const EMPTY_SIDEBAR_STATE: SidebarState = { rows: [], exclude: [] };

/** A tree row's own filter state. */
export type TagFilterState = "include" | "exclude" | "off";

type MintId = () => string;

const defaultMint: MintId = () => filterNodeIdKind.mint();

function isSidebarRule(node: FilterNode): node is FilterRule {
  return (
    node.kind === "rule" &&
    node.fieldId === TAGS_FIELD_ID &&
    (node.operatorId === HAS_NESTED || node.operatorId === LACKS_NESTED)
  );
}

function operandIds(rule: FilterRule): string[] {
  return Array.isArray(rule.value)
    ? rule.value.filter((v): v is string => typeof v === "string")
    : [];
}

/** The rules the sidebar owns: only an `and` root's own children qualify. */
function sidebarRules(filter: FilterGroup | null): FilterRule[] {
  if (filter === null || filter.conjunction !== "and") return [];
  return filter.children.filter(isSidebarRule);
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Every included tag, row by row. */
export function includedTags(state: SidebarState): string[] {
  return state.rows.flat();
}

/** Read the sidebar's state off the view filter. */
export function sidebarState(filter: FilterGroup | null): SidebarState {
  const rules = sidebarRules(filter);
  // A tag in an earlier row is dropped from a later one, so each tag has one
  // place in the box.
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const rule of rules) {
    if (rule.operatorId !== HAS_NESTED) continue;
    const row = unique(operandIds(rule)).filter((id) => !seen.has(id));
    for (const id of row) seen.add(id);
    if (row.length > 0) rows.push(row);
  }
  const exclude = unique(
    rules.filter((r) => r.operatorId === LACKS_NESTED).flatMap(operandIds),
  ).filter((id) => !seen.has(id));
  return { rows, exclude };
}

/** One tag's state in the sidebar. */
export function tagFilterState(
  state: SidebarState,
  tagId: string,
): TagFilterState {
  if (state.rows.some((row) => row.includes(tagId))) return "include";
  if (state.exclude.includes(tagId)) return "exclude";
  return "off";
}

/**
 * The view filter without the sidebar's rules — what the sidebar's faceted
 * counts are computed against, so a tag's count says how many places it would
 * add, not how many survive the sidebar's own picks. `null` when nothing else
 * is left; the filter itself (same identity) when the sidebar owns none of it.
 */
export function withoutSidebarRules(
  filter: FilterGroup | null,
): FilterGroup | null {
  if (filter === null || filter.conjunction !== "and") return filter;
  const children = filter.children.filter((c) => !isSidebarRule(c));
  if (children.length === filter.children.length) return filter;
  return children.length === 0 ? null : { ...filter, children };
}

/**
 * Write `state` back into the view filter: the sidebar's rules are replaced
 * (their ids reused in order, so an edit does not re-key every rule), and
 * every other node is kept as it was. An `or` root that holds anything is
 * wrapped as the first child of a new `and` root, since the sidebar's rules
 * narrow the whole view. `null` when the result constrains nothing.
 */
export function applySidebarState(
  filter: FilterGroup | null,
  state: SidebarState,
  mintId: MintId = defaultMint,
): FilterGroup | null {
  const base: FilterGroup =
    filter === null
      ? { kind: "group", id: mintId(), conjunction: "and", children: [] }
      : filter.conjunction === "and"
        ? filter
        : filter.children.length === 0
          ? { ...filter, conjunction: "and" }
          : {
              kind: "group",
              id: mintId(),
              conjunction: "and",
              children: [filter],
            };
  const reusable = base.children.filter(isSidebarRule).map((r) => r.id);
  const nextId = () => reusable.shift() ?? mintId();
  const rule = (operatorId: string, ids: string[]): FilterRule => ({
    kind: "rule",
    id: nextId(),
    fieldId: TAGS_FIELD_ID,
    operatorId,
    value: ids,
  });

  const owned: FilterRule[] = [];
  for (const row of state.rows) {
    if (row.length > 0) owned.push(rule(HAS_NESTED, row));
  }
  if (state.exclude.length > 0) owned.push(rule(LACKS_NESTED, state.exclude));

  const children = [
    ...owned,
    ...base.children.filter((c) => !isSidebarRule(c)),
  ];
  return children.length === 0 ? null : { ...base, children };
}

/** A tag's root: its top ancestor (itself when it is a root). */
export function rootOf(tagId: string, tags: readonly TagNode[]): string {
  return tagPath(tagId, tags)[0]?.id ?? tagId;
}

/** Drop emptied rows. */
function compact(rows: readonly string[][]): string[][] {
  return rows.filter((row) => row.length > 0);
}

/**
 * Include a tag. It replaces any included tag it subsumes (one nested under
 * it) and any included ancestor it narrows, so the rows never say the same
 * thing twice. Then it joins the row whose tags share its root — tags of one
 * facet are alternatives (Museums or Viewpoints) — else it starts a row of
 * its own, AND-ed with the rest (… and Want to go). Clears its exclusion.
 */
export function includeTag(
  state: SidebarState,
  tagId: string,
  tags: readonly TagNode[],
): SidebarState {
  const ancestors = new Set(
    tagPath(tagId, tags)
      .map((t) => t.id)
      .filter((id) => id !== tagId),
  );
  const rows = compact(
    state.rows.map((row) =>
      row.filter((t) => !isTagUnder(t, tagId, tags) && !ancestors.has(t)),
    ),
  );
  const root = rootOf(tagId, tags);
  const at = rows.findIndex((row) => row.some((t) => rootOf(t, tags) === root));
  return {
    rows:
      at === -1
        ? [...rows, [tagId]]
        : rows.map((row, i) => (i === at ? [...row, tagId] : row)),
    exclude: state.exclude.filter((t) => t !== tagId),
  };
}

/**
 * A click on a tree row: off → include ({@link includeTag}), and a picked tag
 * (included, or excluded through the advanced filter) → off. A click never
 * excludes: an exclusion is written in the advanced filter.
 */
export function toggleTag(
  state: SidebarState,
  tagId: string,
  tags: readonly TagNode[],
): SidebarState {
  if (tagFilterState(state, tagId) !== "off") return removeTag(state, tagId);
  return includeTag(state, tagId, tags);
}

/** Drop a tag from the rows and the exclude list (its chip's ×). */
export function removeTag(state: SidebarState, tagId: string): SidebarState {
  return {
    rows: compact(state.rows.map((row) => row.filter((t) => t !== tagId))),
    exclude: state.exclude.filter((t) => t !== tagId),
  };
}

function assertRow(state: SidebarState, row: number): string[] {
  const tags = state.rows[row];
  if (tags === undefined) {
    throw new Error(`No tag-filter row ${row} (of ${state.rows.length})`);
  }
  return tags;
}

/**
 * The `or` before chip `at` of `row`, clicked: the row splits there into two
 * rows, AND-ed — "Museums or Viewpoints" becomes "Museums and Viewpoints".
 */
export function splitRow(
  state: SidebarState,
  row: number,
  at: number,
): SidebarState {
  const tags = assertRow(state, row);
  if (at <= 0 || at >= tags.length) {
    throw new Error(`Cannot split a ${tags.length}-tag row at ${at}`);
  }
  return {
    ...state,
    rows: [
      ...state.rows.slice(0, row),
      tags.slice(0, at),
      tags.slice(at),
      ...state.rows.slice(row + 1),
    ],
  };
}

/** The `and` between `row` and the next, clicked: the two become one OR-row. */
export function mergeRows(state: SidebarState, row: number): SidebarState {
  const first = assertRow(state, row);
  const second = assertRow(state, row + 1);
  return {
    ...state,
    rows: [
      ...state.rows.slice(0, row),
      [...first, ...second],
      ...state.rows.slice(row + 2),
    ],
  };
}

/**
 * A chip dropped on row `to` (it joins that row's alternatives) or on
 * "and …" (`"new"`: a row of its own, last). Row indices are the state's
 * own, before the move; a row the move empties disappears.
 */
export function moveTag(
  state: SidebarState,
  tagId: string,
  to: number | "new",
): SidebarState {
  if (to !== "new") assertRow(state, to);
  const rows = state.rows.map((row) => row.filter((t) => t !== tagId));
  if (to === "new") rows.push([tagId]);
  else rows[to] = [...rows[to]!, tagId];
  return {
    rows: compact(rows),
    exclude: state.exclude.filter((t) => t !== tagId),
  };
}

/** The part of a tag a preset's name and icon read. */
interface NamedTag extends TagNode {
  readonly name: string;
}

/**
 * A preset's name as the filter reads: each row's tags joined by "or", the
 * rows by " · ", then each excluded tag as "not …" — "Museums or Viewpoints ·
 * Want to go". "New preset" when nothing is picked.
 */
export function presetAutoName(
  state: SidebarState,
  tags: readonly NamedTag[],
): string {
  const byId = new Map(tags.map((t) => [t.id, t.name]));
  const name = (id: string) => byId.get(id);
  const known = (ids: readonly string[]) =>
    ids.map(name).filter((n): n is string => n !== undefined);
  const parts = [
    ...state.rows.map((row) => known(row).join(" or ")),
    ...known(state.exclude).map((n) => `not ${n}`),
  ].filter((part) => part !== "");
  return parts.length === 0 ? "New preset" : parts.join(" · ");
}

/**
 * A preset's icon: the first included tag's (its own, else its nearest
 * ancestor's); null when no included tag has one.
 */
export function presetIcon<I>(
  state: SidebarState,
  tags: readonly (NamedTag & { readonly icon: I | null })[],
): I | null {
  for (const tagId of includedTags(state)) {
    const withIcon = tagPath(tagId, tags)
      .reverse()
      .find((t) => t.icon !== null);
    if (withIcon) return withIcon.icon;
  }
  return null;
}

/** A row click applied to the filter in one step. */
export function applySidebarClick(
  filter: FilterGroup | null,
  tagId: string,
  tags: readonly TagNode[],
  mintId: MintId = defaultMint,
): FilterGroup | null {
  return applySidebarState(
    filter,
    toggleTag(sidebarState(filter), tagId, tags),
    mintId,
  );
}

/** Whether any of a tag's descendants is included or excluded (its row's partial mark). */
export function hasPickedDescendant(
  state: SidebarState,
  tagId: string,
  tags: readonly TagNode[],
): boolean {
  return [...includedTags(state), ...state.exclude].some(
    (t) => t !== tagId && isTagUnder(t, tagId, tags),
  );
}
