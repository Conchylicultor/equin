import { useSlotOrder } from "@plugins/primitives/plugins/slot-render/web";
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
import {
  foldResource,
  mapResource,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Surface } from "../slots";

/**
 * Surface-mode control contributed into `ActionBar.ViewOption` — a "Layout" row
 * in the action bar's view-options popover. Provider-free: it
 * reads the ONE surface mode from the module-level store (`useSurfaceMode`) and
 * drives it via `setSurfaceMode`, so it renders correctly both inside
 * `TabsProvider` (the docked tab-bar strip's popover) and outside it (the
 * globally-mounted floating overlay's).
 *
 * The options are derived from the `Surface.Placement` registry, in the slot's
 * layout order (`useSlotOrder`) — never a hardcoded list — so adding / removing a mode sub-plugin
 * updates the control with zero edits here. With no modes contributed it renders
 * nothing. While the order is not known yet the "Layout" row is already there,
 * a loading block in place of the control (never the modes in raw order); a
 * failed order with nothing last-known renders nothing.
 */
export function ActionBarPlacementControl() {
  const defs = useSlotOrder(Surface.Placement);
  const options = useMemo(
    () =>
      mapResource(defs, (list) =>
        list.map((d): SegmentedOption<string> => ({
          id: d.id,
          icon: <Icon icon={d.icon} />,
          // Icon-only: the mode's label is the radio's tooltip and name.
          tooltip: d.label,
        })),
      ),
    [defs],
  );
  const mode = useSurfaceMode();
  // The options to draw: none while loading (a loading block holds the row),
  // the last-known ones on a failed refresh, nothing on a failure without one.
  const known: "loading" | readonly SegmentedOption<string>[] | null =
    foldResource(options, {
      loading: (): "loading" | readonly SegmentedOption<string>[] | null =>
        "loading",
      error: (_error, stale) => stale ?? null,
      ready: (data) => data,
    });
  if (known === null || (known !== "loading" && known.length === 0)) {
    return null;
  }
  return (
    <ControlPanel.Setting
      label="Layout"
      fit="inline"
      control={
        known === "loading" ? (
          // Roughly the segmented control's footprint, so the row does not jump.
          <Loading variant="block" className="h-7 w-24" />
        ) : (
          <SegmentedControl<string>
            options={known}
            value={mode}
            onChange={setSurfaceMode}
            variant="ghost"
          />
        )
      }
    />
  );
}
