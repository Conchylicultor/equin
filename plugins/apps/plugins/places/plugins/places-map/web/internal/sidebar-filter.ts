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
} from "@plugins/apps/plugins/places/plugins/places-core/core";

// The tag sidebar's half of the view filter. The view's filter tree is the one
// source of truth; the sidebar owns exactly the TOP-LEVEL rules of an `and`
// root on the tags field with the nested operators, and leaves every other
// rule and group untouched:
//
//   include, any → ONE `has-nested` rule holding every included tag
//   include, all → one `has-nested` rule PER included tag
//   exclude      → ONE `lacks-nested` rule holding every excluded tag
//
// So the advanced filter builder shows the same rules ("Tags has any of (incl.
// nested) …") and a rule the user writes there with these operators at the top
// level is the sidebar's to show and edit. A row click only includes; an
// exclusion is written in the advanced filter (the sidebar shows it, and a
// click or its chip's × drops it).

/** The places field id the sidebar's rules test. */
export const TAGS_FIELD_ID = "tags";
/** "Has any of these, or anything nested under them." */
export const HAS_NESTED = "has-nested";
/** "Has none of these, nor anything nested under them." */
export const LACKS_NESTED = "lacks-nested";

export type IncludeMode = "any" | "all";

/** What the sidebar shows: which tags are included / excluded, and how. */
export interface SidebarState {
  include: string[];
  exclude: string[];
  /** `any` only when one include rule holds several tags; else `all` (the default). */
  mode: IncludeMode;
}

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

/** Read the sidebar's state off the view filter. */
export function sidebarState(filter: FilterGroup | null): SidebarState {
  const rules = sidebarRules(filter);
  const includeRules = rules.filter((r) => r.operatorId === HAS_NESTED);
  const include = unique(includeRules.flatMap(operandIds));
  const exclude = unique(
    rules.filter((r) => r.operatorId === LACKS_NESTED).flatMap(operandIds),
  );
  return {
    include,
    exclude: exclude.filter((id) => !include.includes(id)),
    mode: includeRules.length === 1 && include.length > 1 ? "any" : "all",
  };
}

/** One tag's state in the sidebar. */
export function tagFilterState(
  state: SidebarState,
  tagId: string,
): TagFilterState {
  if (state.include.includes(tagId)) return "include";
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
  if (state.include.length > 0) {
    if (state.mode === "any") owned.push(rule(HAS_NESTED, state.include));
    else for (const id of state.include) owned.push(rule(HAS_NESTED, [id]));
  }
  if (state.exclude.length > 0) owned.push(rule(LACKS_NESTED, state.exclude));

  const children = [
    ...owned,
    ...base.children.filter((c) => !isSidebarRule(c)),
  ];
  return children.length === 0 ? null : { ...base, children };
}

/**
 * A click on a tree row: off → include, and a picked tag (included, or
 * excluded through the advanced filter) → off. Including a tag replaces any
 * included tag it subsumes (one nested under it) and any included ancestor it
 * narrows, so the include list never says the same thing twice.
 */
export function toggleTag(
  state: SidebarState,
  tagId: string,
  tags: readonly TagNode[],
): SidebarState {
  if (tagFilterState(state, tagId) !== "off") return removeTag(state, tagId);
  const ancestors = new Set(
    tagPath(tagId, tags)
      .map((t) => t.id)
      .filter((id) => id !== tagId),
  );
  return {
    ...state,
    include: [
      ...state.include.filter(
        (t) => !isTagUnder(t, tagId, tags) && !ancestors.has(t),
      ),
      tagId,
    ],
  };
}

/** Drop a tag from both lists (its chip's ×). */
export function removeTag(state: SidebarState, tagId: string): SidebarState {
  return {
    ...state,
    include: state.include.filter((t) => t !== tagId),
    exclude: state.exclude.filter((t) => t !== tagId),
  };
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
  return [...state.include, ...state.exclude].some(
    (t) => t !== tagId && isTagUnder(t, tagId, tags),
  );
}
