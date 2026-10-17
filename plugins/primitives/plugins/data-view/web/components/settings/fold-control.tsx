import { useCallback, type ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import type { FilterGroup } from "../../../core";
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
 * `GroupByControl`): the view's fold rule — rows NOT matching it fold behind a
 * "… N more" fold line at the end of their section.
 *
 * The rule is an ordinary `FilterGroup`, so it is edited with the filter
 * builder itself, pushed as a page and pointed at `fold.keep` by
 * `FoldFilterScope`. The section's row says the rule in words (the same
 * `summarizeFilter` the filter control's tooltip uses), and a second row clears
 * it.
 *
 * Not the tree's fold-children header action — that collapses subtrees; this
 * sets rows aside behind a fold line.
 */
export function FoldControl(): ReactNode {
  const { fields, activeState, activeViewId, viewModel, filter } =
    useDataViewControls();
  const fold = activeState.fold;
  const summary = fold
    ? summarizeFilter(fold.keep, fields, filter.resolveOperatorSet)
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
        {summary ? `Keep ${summary.label}` : "Off"}
      </ControlPanel.Row>
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
      viewModel.setFold(activeViewId, keep ? { keep } : null),
    [viewModel, activeViewId],
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
