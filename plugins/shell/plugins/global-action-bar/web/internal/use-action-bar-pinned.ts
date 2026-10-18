import {
  placementOwnsChrome,
  usePlacementCapabilities,
  useSurfaceMode,
} from "@plugins/apps-core/plugins/tabs/web";

/**
 * Whether the bar is pinned (docked in the tab bar) — derived from the surface
 * mode, never stored. A mode that keeps the tab bar (docked tabs) docks the bar
 * there; a mode that draws its own frame (solo, the desktop — its `ownsChrome`
 * capability, the same one that unmounts the tab bar) has no tab bar to dock
 * into, so the bar floats over the surface instead. Both hosts read this one
 * answer, so exactly one of them renders at a time.
 */
export function useActionBarPinned(): boolean {
  return !placementOwnsChrome(usePlacementCapabilities(), useSurfaceMode());
}
