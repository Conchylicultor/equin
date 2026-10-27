import { Fragment, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  renderIsolated,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { DataViewSlots } from "../../slots";
import { slotLayout } from "../../internal/slot-layout";
import { useDataViewControls } from "../controls/controls-context";

/**
 * The settings control's panel body — the unified view-settings panel. It hosts
 * two contributable scopes:
 *
 *  - **Current view** — per-instance settings (`scope: "view"`); properties and
 *    group-by are such contributions.
 *  - **DataView** — surface-wide settings (`scope: "global"`); custom-columns'
 *    "Fields" UI is one such contribution (it imports the slot directly — the
 *    dependency is inverted, so the host names no individual setting).
 *
 * The body is a flat run of contributions, view scope first, each in the slot's
 * layout order,
 * rendered uniformly through `renderIsolated` (error-boundary-isolated). **Each
 * contribution renders its own `ControlPanel.Section`** — so the host wraps
 * nothing, adds no element between the panel and a section, and the hairline
 * between two settings is drawn by the panel container rather than placed by
 * anyone. A contribution that self-hides therefore leaves no orphan rule behind
 * it, and the two scopes read as separated because their contributions are
 * ordered, not because a scope header says so.
 *
 * It no longer owns its own gear or popover — those are the toolbar's, built
 * generically from this control's `icon` and `label` like every other control's.
 * With that goes the self-hide: `isApplicable` on a `Control` is a pure function
 * and cannot read another slot's contributions, so settings is always applicable
 * and an empty panel says so. In practice nothing changes — custom-columns'
 * "Fields" setting declares no `isApplicable`, so the gear was already always
 * visible on every surface.
 */
export function SettingsControlPanel(): ReactNode {
  const context = useDataViewControls();

  const layout = slotLayout(useSlotOrder(DataViewSlots.Setting));
  // The settings' layout not known yet is not "nothing to configure": that
  // would be a claim about this surface the panel then takes back.
  if (layout.kind === "loading") return <Loading variant="rows" />;
  if (layout.kind === "failed") {
    return (
      <ResourceErrorInline
        variant="block"
        error={layout.failure.error}
        refetch={layout.failure.refetch}
        subject="the view settings"
      />
    );
  }
  const settings = layout.items;
  // Each contribution declares its own applicability (`isApplicable`); the panel
  // stays generic — it never names group-by / properties. A setting filtered out
  // here is the one that would self-hide, so no section ever renders empty.
  const applicable = (s: (typeof settings)[number]) =>
    s.isApplicable?.(context) ?? true;
  const ordered = [
    ...settings.filter((s) => s.scope === "view" && applicable(s)),
    ...settings.filter((s) => s.scope === "global" && applicable(s)),
  ];

  if (ordered.length === 0) {
    return <ControlPanel.Empty>Nothing to configure here.</ControlPanel.Empty>;
  }

  return (
    <>
      {ordered.map((c) => (
        // A `Fragment` and not a `div`: the panel body lays its BANDS out itself
        // (a flex container, which reaches through `renderIsolated`'s
        // `display: contents` lineage span). A `div` here would generate a real
        // box, so it — not the sections inside it — would be the flex item, and
        // the settings would lose both their spacing and their hairlines.
        <Fragment key={c.id}>
          {renderIsolated(
            DataViewSlots.Setting,
            c as unknown as Contribution,
            {},
          )}
        </Fragment>
      ))}
    </>
  );
}
