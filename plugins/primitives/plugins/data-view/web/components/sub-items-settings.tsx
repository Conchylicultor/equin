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
import type { FilterScope, Nesting, SubItemsKind } from "../../core";
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
 * The view settings' Sub-items section, for a surface whose rows have
 * sub-items — Notion's per-view "Sub-items" setting: a `hierarchy`, offered on
 * a view type that nests one (`nestsHierarchy`), or rows that `attach` beneath
 * others, offered on a view type that draws them (`nestsAttach`). A view that
 * never nests them has nothing to switch. `nesting` and `filterScope` are
 * host-injected keys of the view row, merge-written so every other key stays.
 */
const hierarchySettings: HostViewSettings<DataViewContribution> = (
  instance,
  actions,
) =>
  instance.viewType.nestsHierarchy === true ? (
    <SubItemsSettings kind="hierarchy" instance={instance} actions={actions} />
  ) : null;

const attachSettings: HostViewSettings<DataViewContribution> = (
  instance,
  actions,
) =>
  instance.viewType.nestsAttach === true ? (
    <SubItemsSettings kind="attach" instance={instance} actions={actions} />
  ) : null;

/** The Sub-items settings for a surface whose rows have `kind` sub-items —
 *  `undefined` for one without (nothing to offer). Stable per kind. */
export function subItemsSettingsFor(
  kind: SubItemsKind | null,
): HostViewSettings<DataViewContribution> | undefined {
  return kind === "hierarchy"
    ? hierarchySettings
    : kind === "attach"
      ? attachSettings
      : undefined;
}

function SubItemsSettings(props: {
  kind: SubItemsKind;
  instance: ResolvedViewInstance<DataViewContribution>;
  actions: ViewActionsCore;
}): ReactNode {
  const { kind, instance, actions } = props;
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
        hint={
          kind === "hierarchy"
            ? "Nested draws children under their parent; Flat lists every row with a Parent column; Parents only lists the top-level rows."
            : "Nested draws attached rows under the row they belong to; Flat lists every row on its own; Parents only hides the attached rows."
        }
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
      {kind === "hierarchy" && nesting === "nested" ? (
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
