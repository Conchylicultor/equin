import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { usePlacementRegistry } from "./placement-registry";
import { useTabs, useTabsIfAny } from "./use-tabs";

/**
 * Whether the calling surface is on screen as an open app — the operating
 * system's sense, not the keyboard's: the focused tab, or any open tab while
 * the surface mode paints unfocused tabs too (the desktop's windows, a
 * minimized one included — minimizing a window does not close its app).
 *
 * The question an app's sound asks: in a mode that shows one tab at a time,
 * leaving the tab is leaving the app; on the desktop, clicking another window
 * is not. {@link useSurfaceFocused} is the keyboard's question (which surface
 * a key press is for), which this is not.
 *
 * Outside any surface (chrome) the answer is `true`, as for
 * `useSurfaceFocused`.
 */
export function useSurfaceShown(): boolean {
  const tabId = useSurfaceTabId();
  const { focusedTabId, mode } = useTabs();
  const caps = usePlacementRegistry().useValue();
  if (tabId === undefined) return true;
  return tabId === focusedTabId || (caps?.showsUnfocused.has(mode) ?? false);
}

/**
 * Whether the calling surface shows apps side by side — an open tab in a mode
 * that paints unfocused tabs (the desktop's windows) — rather than one at a
 * time. There, leaving the surface is closing its app (its window), not
 * switching to another one: what the app played ends with it.
 *
 * Outside any surface or tab set the answer is `false`.
 */
export function useSurfaceShowsAppsSideBySide(): boolean {
  const tabId = useSurfaceTabId();
  const tabs = useTabsIfAny();
  const caps = usePlacementRegistry().useValue();
  if (tabId === undefined || tabs === null) return false;
  return caps?.showsUnfocused.has(tabs.mode) ?? false;
}
