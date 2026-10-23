import { Icon } from "@plugins/ui/plugins/icons/web";
import { useMemo } from "react";
import {
  useSurfaceMode,
  setSurfaceMode,
} from "@plugins/apps-core/plugins/tabs/web";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Surface } from "../slots";

/**
 * Surface-mode control contributed into `ActionBar.ViewOption` — a "Layout" row
 * in the action bar's view-options popover. Provider-free: it
 * reads the ONE surface mode from the module-level store (`useSurfaceMode`) and
 * drives it via `setSurfaceMode`, so it renders correctly both inside
 * `TabsProvider` (the docked tab-bar strip's popover) and outside it (the
 * globally-mounted floating overlay's).
 *
 * The options are derived from the `Surface.Placement` registry (sorted by
 * `order`) — never a hardcoded list — so adding / removing a mode sub-plugin
 * updates the control with zero edits here. With no modes contributed it renders
 * nothing.
 */
export function ActionBarPlacementControl() {
  const defs = Surface.Placement.useContributions();
  const options = useMemo(
    () =>
      [...defs]
        .sort((a, b) => a.order - b.order)
        .map((d): SegmentedOption<string> => ({
          id: d.id,
          icon: <Icon icon={d.icon} />,
          // Icon-only: the mode's label is the radio's tooltip and name.
          tooltip: d.label,
        })),
    [defs],
  );
  const mode = useSurfaceMode();
  if (options.length === 0) return null;
  return (
    <ControlPanel.Setting
      label="Layout"
      fit="inline"
      control={
        <SegmentedControl<string>
          options={options}
          value={mode}
          onChange={setSurfaceMode}
          variant="ghost"
        />
      }
    />
  );
}
