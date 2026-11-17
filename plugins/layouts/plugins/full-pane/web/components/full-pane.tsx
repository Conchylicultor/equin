import { DeferredRouteFallback } from "@plugins/layouts/plugins/route-fallback/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import {
  PaneBox,
  PaneInstance,
  PaneLayoutContext,
  paneOwnerFor,
  usePaneMatch,
} from "@plugins/primitives/plugins/pane/web";
import { UiRegion } from "@plugins/primitives/plugins/ui-context/web";

// A full-pane surface is the only column, so it IS both the surface start and
// end edge — a full-surface pane's header hosts the sidebar toggle and reserves
// the floating-action-bar safe area. There is no maximize/drag in full-pane, and
// a pane with a parent shows Back rather than × (its ancestors are off screen).
// Module-level constant so the context value keeps a stable identity.
const FULL_PANE_LAYOUT_CTX = {
  onDoubleClickHeader: () => {},
  atSurfaceStart: true,
  atSurfaceEnd: true,
  ancestorsHidden: true,
} as const;

/**
 * Full-surface layout renderer: paints only the **active pane**
 * (`match.panes.at(-1)`) filling the whole surface — no columns, no
 * ancestors. The screen-stack navigation model: each `mode:"root"` open
 * replaces the route with a single pane, so the active pane *is* the screen.
 *
 * Pure consumer of the surface's route match: `PaneSurfaceProvider` resolves it
 * once for the whole surface (`PaneMatchContext`), so this renderer neither
 * syncs the registry nor provides the context — it only paints.
 */
export function FullPane() {
  const match = usePaneMatch();
  // Active pane = last entry.
  const active = match?.panes?.at(-1);
  // No active pane. On a cold deep-link the target pane's plugin may still be
  // loading in the deferred tier, so show a loading placeholder while that is in
  // progress; once deferred loading settles this falls back to null (a real
  // no-match). See route-fallback for the full rationale.
  if (!active) return <DeferredRouteFallback />;
  return (
    <PaneInstance entry={active}>
      <PaneLayoutContext.Provider value={FULL_PANE_LAYOUT_CTX}>
        {/* The active pane as a named lineage region, so a picked element
            reports the pane that contains it AND the plugin that owns it. No
            `label`: a full-pane surface paints exactly one pane, so there are no
            siblings to disambiguate. */}
        <UiRegion
          kind="pane"
          id={active.pane.id}
          pluginId={paneOwnerFor(active.pane)}
        >
          <PluginErrorBoundary slot="layouts.full-pane" label={active.pane.id}>
            {/* `PaneBox` is the pane's own box: it stamps the pane id and the
                home app's theme scope on the element AND forwards both across
                portals, so popovers opened from this pane still report their
                containing pane and keep its theme. `data-pane-id` is a separate,
                load-bearing DOM convention with its own readers (render-loop
                attribution, overscroll-hint, e2e) — the region marker above is
                additive alongside it, not a replacement. This renderer owns only
                the box's size: a full-surface pane fills its host. */}
            <PaneBox
              pane={active.pane}
              params={active.params}
              className="h-full min-h-0"
            />
          </PluginErrorBoundary>
        </UiRegion>
      </PaneLayoutContext.Provider>
    </PaneInstance>
  );
}
