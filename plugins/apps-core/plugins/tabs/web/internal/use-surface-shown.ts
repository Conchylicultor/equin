import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { usePlacementRegistry } from "./placement-registry";
import { useTabs } from "./use-tabs";

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
