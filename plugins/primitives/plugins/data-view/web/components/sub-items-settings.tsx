import type { ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import type {
  HostViewSettings,
  ResolvedViewInstance,
  ViewActionsCore,
} from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type { FilterScope, Nesting } from "../../core";
import type { DataViewContribution } from "../slots";

const NESTING_OPTIONS: readonly SegmentedOption<Nesting>[] = [
  { id: "nested", label: "Nested" },
  { id: "flat", label: "Flat" },
  { id: "roots", label: "Parents only" },
];

const FILTER_SCOPE_OPTIONS: readonly SegmentedOption<FilterScope>[] = [
  { id: "rows", label: "Any row" },
  { id: "roots", label: "Top-level" },
];

/**
 * The view settings' Sub-items section, for a surface over a hierarchical
 * source — Notion's per-view "Sub-items" setting. Offered only on a view type
 * that can nest (`nestsHierarchy`): a view that never nests has nothing to
 * switch. `nesting` and `filterScope` are host-injected keys of the view row,
 * merge-written so every other key stays.
 */
export const subItemsSettings: HostViewSettings<DataViewContribution> = (
  instance,
  actions,
) =>
  instance.viewType.nestsHierarchy === true ? (
    <SubItemsSettings instance={instance} actions={actions} />
  ) : null;

function SubItemsSettings(props: {
  instance: ResolvedViewInstance<DataViewContribution>;
  actions: ViewActionsCore;
}): ReactNode {
  const { instance, actions } = props;
  const id = instance.instance.id;
  const view = instance.instance.options as VariantValue | undefined;
  const nesting: Nesting =
    view?.nesting === "flat" || view?.nesting === "roots"
      ? view.nesting
      : "nested";
  const filterScope: FilterScope =
    view?.filterScope === "roots" ? "roots" : "rows";
  // Merge-written over the raw view: every other key of the row stays.
  const write = (patch: { nesting: Nesting } | { filterScope: FilterScope }) =>
    actions.updateView(
      id,
      { ...patch, type: instance.instance.type },
      { merge: true },
    );
  return (
    <ControlPanel.Section label="Sub-items">
      <ControlPanel.Setting
        label="Show"
        hint="Nested draws children under their parent; Flat lists every row with a Parent column; Parents only lists the top-level rows."
        fit="inline"
        control={
          <SegmentedControl<Nesting>
            label="Sub-items"
            options={NESTING_OPTIONS}
            value={nesting}
            onChange={(next) => write({ nesting: next })}
            variant="ghost"
          />
        }
      />
      {nesting === "nested" ? (
        <ControlPanel.Setting
          label="Filter matches"
          hint="Any row keeps each match with its parents; Top-level tests only the top-level rows, each keeping its whole subtree."
          fit="inline"
          control={
            <SegmentedControl<FilterScope>
              label="Filter matches"
              options={FILTER_SCOPE_OPTIONS}
              value={filterScope}
              onChange={(next) => write({ filterScope: next })}
              variant="ghost"
            />
          }
        />
      ) : null}
    </ControlPanel.Section>
  );
}
