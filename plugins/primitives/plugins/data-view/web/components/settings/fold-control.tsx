import { useCallback, useState, type ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { isFoldLimit, type FilterGroup, type FoldLimit } from "../../../core";
import { foldRuleOf } from "../../internal/fold-sections";
import { useFilterController } from "../../internal/use-filter-controller";
import { summarizeFilter } from "../../internal/summarize-filter";
import {
  DataViewControlsProvider,
  useDataViewControls,
} from "../controls/controls-context";
import { FilterEditorPanel } from "../filter/filter-control-panel";
import { FilterScopeProvider } from "../filter/filter-scope";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");
const unfoldLessIcon = symbol("unfold-less");

/**
 * "Fold rows" setting (a `view`-scope settings contribution, modelled on
 * `GroupByControl`): the view's fold rule — rows NOT matching its `keep`, or
 * past each section's first `limit`, fold behind a "… N more" fold line at the
 * end of their section.
 *
 * `keep` is an ordinary `FilterGroup`, so it is edited with the filter
 * builder itself, pushed as a page and pointed at `fold.keep` by
 * `FoldFilterScope`. Its row says the rule in words (the same
 * `summarizeFilter` the filter control's tooltip uses). `limit` is a number
 * field beside it ("Show first", empty = no limit). Each half is written with
 * the other kept (`foldRuleOf`), and a last row clears both.
 *
 * Not the tree's fold-children header action — that collapses subtrees; this
 * sets rows aside behind a fold line.
 */
export function FoldControl(): ReactNode {
  const { fields, activeState, activeViewId, viewModel, filter } =
    useDataViewControls();
  const fold = activeState.fold;
  const summary = fold
    ? summarizeFilter(fold.keep ?? null, fields, filter.resolveOperatorSet)
    : null;

  return (
    <ControlPanel.Section label="Fold rows">
      <ControlPanel.Row
        icon={<Icon icon={unfoldLessIcon} />}
        hint="Rows that don't match fold behind “… N more” at the end of their group. Searching shows every match."
        trailing={summary?.more ? `+${summary.more}` : undefined}
        push={{
          key: "fold-rows",
          title: "Fold rows",
          render: () => (
            <FoldFilterScope>
              <FilterEditorPanel presets={false} clearLabel="Clear fold" />
            </FoldFilterScope>
          ),
        }}
      >
        {summary
          ? `Keep ${summary.label}`
          : fold?.limit !== undefined
            ? "Keep every row"
            : "Off"}
      </ControlPanel.Row>
      <ControlPanel.Setting
        label="Show first"
        hint="Show only each group's first rows, in the view's order; the rest fold behind “… N more”. Empty shows every row."
        fit="inline"
        control={
          <FoldLimitInput
            value={fold?.limit}
            onCommit={(limit) =>
              viewModel.setFold(activeViewId, foldRuleOf(fold?.keep, limit))
            }
          />
        }
      />
      {fold ? (
        <ControlPanel.Row
          icon={<Icon icon={closeIcon} />}
          tone="danger"
          onSelect={() => viewModel.setFold(activeViewId, null)}
        >
          Clear fold
        </ControlPanel.Row>
      ) : null}
    </ControlPanel.Section>
  );
}

/**
 * The filter scope that points the filter builder at the active view's fold
 * rule: the enclosing controls context, with ONLY `filter` swapped for a
 * controller over `fold.keep` that writes through `viewModel.setFold`. Presets,
 * sort and everything else stay the view's.
 *
 * It re-derives that controller from the live context on every render and
 * registers ITSELF as the scope, so a sub-page the builder pushes (a nested
 * group, the add-filter list) re-enters it and edits the fold too — never the
 * view's filter. See `useFilterPanelStack`.
 */
function FoldFilterScope({ children }: { children: ReactNode }): ReactNode {
  const ctx = useDataViewControls();
  const { viewModel, activeViewId } = ctx;
  const setKeep = useCallback(
    (keep: FilterGroup | null) =>
      viewModel.setFold(
        activeViewId,
        foldRuleOf(keep, ctx.activeState.fold?.limit),
      ),
    [viewModel, activeViewId, ctx.activeState.fold?.limit],
  );
  const foldFilter = useFilterController(
    ctx.fields,
    ctx.activeState.fold?.keep ?? null,
    setKeep,
  );
  return (
    <DataViewControlsProvider {...ctx} filter={foldFilter}>
      <FilterScopeProvider scope={FoldFilterScope}>
        {children}
      </FilterScopeProvider>
    </DataViewControlsProvider>
  );
}

/**
 * The fold's row limit, written once the person is done typing (blur / Enter):
 * a positive whole number, or empty for no limit. Anything else reverts to the
 * stored value.
 */
function FoldLimitInput({
  value,
  onCommit,
}: {
  value: FoldLimit | undefined;
  onCommit: (limit: FoldLimit | undefined) => void;
}): ReactNode {
  const text = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(text);
  const [shown, setShown] = useState(text);
  if (shown !== text) {
    setShown(text);
    setDraft(text);
  }
  const commit = (): void => {
    const trimmed = draft.trim();
    const next = trimmed === "" ? undefined : Number(trimmed);
    if (next !== undefined && !isFoldLimit(next)) setDraft(text);
    else if (next !== value) onCommit(next);
  };
  return (
    <Input
      type="number"
      min={1}
      step={1}
      className="w-16 tabular-nums"
      placeholder="All"
      value={draft}
      aria-label="Show only this many rows per group"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
