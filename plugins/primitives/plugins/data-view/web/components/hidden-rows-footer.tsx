import { useMemo, type ReactNode } from "react";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  dataPart,
  type FieldDef,
  type FilterGroup,
  type FilterOperatorSet,
  type ViewState,
} from "../../core";
import { useRowMatcher } from "../internal/use-flat-rows";

const hiddenIcon = symbol("visibility-off");

/** How many distinct values the footer names before "+N". */
const MAX_NAMED_VALUES = 4;

/**
 * `DataViewProps.revealHidden`: the line under the rows saying what the
 * active view's FILTER hides of what its search shows — "3 hidden · tests,
 * docs · Show". The count is the rows passing the search but failing the
 * filter (in memory, so it is exact); the words are the distinct values those
 * rows hold in the fields the filter names (their option labels where the
 * field declares options). Show clears the view's filter — through the
 * view model, so a draft under `viewEdits`. Nothing when the filter hides
 * nothing.
 */
export function HiddenRowsFooter({
  rows,
  fields,
  state,
  resolveOperatorSet,
  searchAccessor,
  onShow,
}: {
  rows: readonly unknown[];
  fields: FieldDef<unknown>[];
  state: ViewState;
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined;
  searchAccessor: ((row: unknown) => string) | undefined;
  onShow: () => void;
}): ReactNode {
  const searchOnly = useMemo(
    () => ({ query: state.query, filter: null }),
    [state.query],
  );
  const matchesSearch = useRowMatcher(
    fields,
    searchOnly,
    resolveOperatorSet,
    searchAccessor,
  );
  const matchesView = useRowMatcher(
    fields,
    state,
    resolveOperatorSet,
    searchAccessor,
  );
  const hidden = useMemo(
    () =>
      matchesView === null
        ? []
        : rows.filter(
            (row) =>
              (matchesSearch === null || matchesSearch(row)) &&
              !matchesView(row),
          ),
    [rows, matchesSearch, matchesView],
  );
  const values = useMemo(
    () => hiddenValues(hidden, filterFields(state.filter, fields)),
    [hidden, state.filter, fields],
  );
  if (hidden.length === 0) return null;
  const named = values.slice(0, MAX_NAMED_VALUES);
  const more = values.length - named.length;
  return (
    <div className="rail-follow" {...dataPart("dv.hidden-rows")}>
      <Row
        size="sm"
        icon={<Icon icon={hiddenIcon} className="text-faint-foreground" />}
        onClick={onShow}
        aria-label={`Show ${hidden.length} hidden ${hidden.length === 1 ? "row" : "rows"}`}
      >
        <Text variant="caption" className="text-muted-foreground">
          {`${hidden.length} hidden`}
          {named.length > 0
            ? ` · ${named.join(", ")}${more > 0 ? ` +${more}` : ""}`
            : null}
        </Text>
        <Fill />
        <Text variant="caption" className="text-primary-text">
          Show
        </Text>
      </Row>
    </div>
  );
}

/** The fields a filter tree's rules name, in first-seen order. */
function filterFields(
  filter: FilterGroup | null,
  fields: readonly FieldDef<unknown>[],
): FieldDef<unknown>[] {
  if (filter === null) return [];
  const ids: string[] = [];
  const walk = (group: FilterGroup) => {
    for (const node of group.children) {
      if (node.kind === "group") walk(node);
      else if (!ids.includes(node.fieldId)) ids.push(node.fieldId);
    }
  };
  walk(filter);
  return ids.flatMap((id) => {
    const field = fields.find((f) => f.id === id);
    return field === undefined ? [] : [field];
  });
}

/** The distinct values the rows hold in `fields`, as words, lower-cased. */
function hiddenValues(
  rows: readonly unknown[],
  fields: readonly FieldDef<unknown>[],
): string[] {
  const out: string[] = [];
  for (const field of fields) {
    const options =
      field.options ??
      (field.optionsResult?.status === "ready"
        ? field.optionsResult.options
        : undefined);
    for (const row of rows) {
      const raw = field.values
        ? field.values(row)
        : [field.value?.(row) ?? null];
      for (const value of raw) {
        if (value === null || value === undefined || value === "") continue;
        const key = value instanceof Date ? value.toISOString() : String(value);
        const label = (
          options?.find((o) => o.value === key)?.label ?? key
        ).toLowerCase();
        if (!out.includes(label)) out.push(label);
      }
    }
  }
  return out;
}
