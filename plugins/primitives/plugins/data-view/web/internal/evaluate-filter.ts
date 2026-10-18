import {
  and,
  filterColumns,
  matchesFilter,
  or,
  type Filter,
  type Filterable,
  type FilterDomainId,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  FieldDef,
  FilterFieldValue,
  FilterGroup,
  FilterLowerContext,
  FilterNode,
  FilterOperatorSet,
} from "../../core";
import { resolveRuleOperator } from "./rule-resolution";

type ResolveOperatorSet = (typeId: string) => FilterOperatorSet | undefined;

/** A DataView filter tree lowered into the one filter language. */
export interface LoweredFilter {
  /** The lowered tree; `undefined` is the absent filter (keeps every row). */
  filter: Filter | undefined;
  /**
   * Whether any rule's lowering read the clock (a relative date anchor such as
   * "Today" or "within the past week"). Only such a filter needs re-lowering
   * when the day rolls over — see `useFilterClock`.
   */
  readsClock: boolean;
  /**
   * Every rule that does not resolve (its field or operator is gone), in tree
   * order. Each lowered as TRUE above — the filter it is part of keeps every
   * row it would have narrowed — so a caller must not run `filter` as the
   * view's answer while this is non-empty: the body refuses instead
   * (`resolveBodyState`'s `rule-error`), naming these by id.
   */
  unavailable: UnavailableRule[];
}

/** A saved filter rule whose field or operator does not resolve. */
export interface UnavailableRule {
  /** The rule node's id — what removing it from its tree takes. */
  id: string;
  fieldId: string;
  operatorId: string;
}

/**
 * Lower a DataView `FilterGroup` into a filter-language `Filter`, each rule
 * through its operator's `lower` with `ctx.column` = the field id.
 *
 * - An incomplete rule (`lower` answers `undefined`) is TRUE: it keeps every
 *   row. An unresolvable one (dangling field/operator) is TRUE too, and is
 *   reported in `unavailable` — never dropped silently.
 * - `and` drops TRUE children; `or` with any TRUE child is itself TRUE (the
 *   in-memory `some` over a no-op child always held).
 * - An empty group is TRUE; a one-child group is its child.
 *
 * `readsClock` is recorded generically: `ctx.now` is a getter that notes the
 * read, so no operator type is named here.
 */
export function lowerFilterGroup<TRow>(
  group: FilterGroup | null,
  fields: FieldDef<TRow>[],
  resolveOperatorSet: ResolveOperatorSet,
  now: number,
): LoweredFilter {
  let readsClock = false;
  const unavailable: UnavailableRule[] = [];
  const lowerNode = (node: FilterNode): Filter | undefined => {
    if (node.kind === "group") {
      // Every child is lowered (no early return on a TRUE `or` branch), so
      // `unavailable` lists every dangling rule in the tree.
      const children: Filter[] = [];
      let alwaysTrue = false;
      for (const child of node.children) {
        const lowered = lowerNode(child);
        if (lowered === undefined) {
          if (node.conjunction === "or") alwaysTrue = true;
          continue;
        }
        children.push(lowered);
      }
      if (alwaysTrue || children.length === 0) return undefined;
      if (children.length === 1) return children[0];
      return node.conjunction === "and" ? and(...children) : or(...children);
    }
    const resolved = resolveRuleOperator(node, fields, resolveOperatorSet);
    if (!resolved) {
      unavailable.push({
        id: node.id,
        fieldId: node.fieldId,
        operatorId: node.operatorId,
      });
      return undefined;
    }
    const ctx: FilterLowerContext = {
      column: resolved.field.id,
      field: resolved.field as FieldDef<unknown>,
      get now() {
        readsClock = true;
        return now;
      },
    };
    return resolved.op.lower(node.value, ctx);
  };
  const filter = group ? lowerNode(group) : undefined;
  return { filter, readsClock, unavailable };
}

/**
 * The ONE DataView-side adapter from a field's projected value to the row value
 * the filter language reads for `domain`. The language stays strict (a value of
 * the wrong type throws there); a DataView's projections are looser, so they are
 * coerced HERE, once:
 *
 * - text: an array joins with " ", a `Date` is its ISO string, anything else is
 *   `String(v)`;
 * - number: a finite number, else NULL;
 * - boolean: `Boolean(v)` (a projection is truthy-ish), NULL when absent;
 * - instant: a `Date`, epoch ms or a parseable string → `Date`, else NULL;
 * - stringArray: the array, else NULL.
 *
 * `undefined` / `null` are NULL in every domain.
 */
export function coerceToDomain(
  value: FilterFieldValue,
  domain: FilterDomainId,
): unknown {
  if (value === null || value === undefined) return null;
  switch (domain) {
    case "text":
      if (Array.isArray(value)) return value.join(" ");
      if (value instanceof Date) return value.toISOString();
      return String(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "boolean":
      return Boolean(value);
    case "instant": {
      let t = Number.NaN;
      if (value instanceof Date) t = value.getTime();
      else if (typeof value === "number") t = value;
      else if (typeof value === "string" && value !== "") t = Date.parse(value);
      return Number.isFinite(t) ? new Date(t) : null;
    }
    case "stringArray":
      return Array.isArray(value) ? value : null;
  }
}

/**
 * Project a field's filter value off a row: the multi-value `values` accessor
 * when present, else the scalar `value` accessor, else undefined.
 */
function projectFieldValue<TRow>(
  field: FieldDef<TRow>,
  row: TRow,
): FilterFieldValue {
  if (field.values) return field.values(row);
  if (field.value) return field.value(row);
  return undefined;
}

/**
 * Compile a lowered filter into a row predicate: the filter language's
 * `matchesFilter` over a row record of just the columns the filter reads, each
 * projected (`projectFieldValue`) and coerced to its set's domain
 * (`coerceToDomain`). `undefined` keeps every row.
 */
export function makeRowMatcher<TRow>(
  filter: Filter | undefined,
  fields: FieldDef<TRow>[],
  resolveOperatorSet: ResolveOperatorSet,
): (row: TRow) => boolean {
  if (filter === undefined) return () => true;
  const columns: {
    id: string;
    field: FieldDef<TRow>;
    domain: FilterDomainId;
  }[] = [];
  const filterable: Record<string, { domain: FilterDomainId }> = {};
  for (const id of filterColumns(filter)) {
    // Every column was minted by `lowerFilterGroup` from a resolved rule, so a
    // miss here is a lowering that invented a column — a bug, not a no-op.
    const field = fields.find((f) => f.id === id);
    const set = field && resolveOperatorSet(field.type ?? "text");
    if (!field || !set) {
      throw new Error(`data-view filter: no filterable field "${id}"`);
    }
    // An enum over booleans / numbers lowers in its values' domain.
    const domain = field.valueDomain ?? set.domain;
    columns.push({ id, field, domain });
    filterable[id] = { domain };
  }
  const declared: Filterable = filterable;
  return (row) => {
    const record: Record<string, unknown> = {};
    for (const c of columns) {
      record[c.id] = coerceToDomain(projectFieldValue(c.field, row), c.domain);
    }
    return matchesFilter(record, filter, declared);
  };
}

/**
 * Filter rows through a DataView filter tree: lower it once (at `now`), then
 * match every row. A null group keeps every row.
 */
export function applyFilter<TRow>(
  rows: readonly TRow[],
  filter: FilterGroup | null,
  fields: FieldDef<TRow>[],
  resolveOperatorSet: ResolveOperatorSet,
  now: number,
): readonly TRow[] {
  const lowered = lowerFilterGroup(filter, fields, resolveOperatorSet, now);
  if (lowered.filter === undefined) return rows;
  return rows.filter(
    makeRowMatcher(lowered.filter, fields, resolveOperatorSet),
  );
}
