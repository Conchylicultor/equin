import type { ReactNode } from "react";
import {
  CollapsedViewSwitcher,
  ViewList,
} from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import { useDataViewControls } from "./controls/controls-context";
import { useViewRowCounts } from "../internal/use-view-row-counts";

/**
 * The surface's views as a vertical list, for its `aside` (a sidebar of saved
 * filters): icon, name, row count (`useViewRowCounts`), dirty dot, a ⋯ menu
 * (Rename / Duplicate / Delete — none on the home view), drag to reorder (the
 * home view pinned first), and a trailing "+ {newLabel}" row. Reads everything
 * from the controls context, so it renders inside the DataView (`aside`,
 * `asideEnd`, the band) — typically beside `switcherForm="none"`.
 *
 * `onNew` defaults to adding a view of the active view's type (it becomes the
 * active view).
 */
export function DataViewViewList(props: {
  newLabel: string;
  onNew?: () => void;
}): ReactNode {
  const { newLabel, onNew } = props;
  const { viewModel, activeViewId } = useDataViewControls();
  const countFor = useViewRowCounts();
  const create =
    onNew ??
    (() => {
      const active = viewModel.instances.find(
        (r) => r.instance.id === activeViewId,
      );
      if (active === undefined) {
        throw new Error(
          `DataViewViewList: the active view "${activeViewId}" is not listed`,
        );
      }
      viewModel.actions.addView(active.instance.type, active.instance.source);
    });
  return (
    <ViewList
      instances={viewModel.instances}
      activeId={activeViewId}
      onSelect={viewModel.setActiveView}
      actions={viewModel.actions}
      homeId={viewModel.homeViewId}
      countFor={countFor}
      dirtyFor={viewModel.dirtyFor}
      renaming={{ id: viewModel.renamingId, set: viewModel.setRenamingId }}
      create={{ label: newLabel, onCreate: create }}
    />
  );
}

/**
 * The active view as one trigger opening every view as a draggable list
 * (`CollapsedViewSwitcher menu="list"`), reading counts and dirty dots from the
 * controls context — so it renders inside the DataView (band, `aside`,
 * `asideEnd`).
 * - `appearance="chip"` (default): icon, name, row count, dirty dot — the
 *   band's switcher for `switcherForm="chip"` on a drafted surface.
 * - `appearance="title"`: the name as a card's heading, dirty dot, chevron —
 *   for an aside whose header names the active view (its own mark and count
 *   beside it).
 */
export function DataViewViewChip(props: {
  appearance?: "chip" | "title";
}): ReactNode {
  const { appearance = "chip" } = props;
  const { viewModel, activeViewId } = useDataViewControls();
  const countFor = useViewRowCounts();
  return (
    <CollapsedViewSwitcher
      instances={viewModel.instances}
      activeId={activeViewId}
      onSelect={viewModel.setActiveView}
      actions={viewModel.actions}
      menu="list"
      appearance={appearance}
      countFor={countFor}
      dirtyFor={viewModel.dirtyFor}
      homeId={viewModel.homeViewId}
    />
  );
}
