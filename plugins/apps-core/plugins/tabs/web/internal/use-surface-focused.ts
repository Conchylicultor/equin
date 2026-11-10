import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { useTabs } from "./use-tabs";

/**
 * Whether the calling surface is the focused tab.
 *
 * The trap it removes: tabs are keep-alive. Every open tab stays MOUNTED (the
 * unfocused ones are hidden, and under the floating placement several
 * are on screen at once), so a `window`-level listener a pane registers — an
 * Escape handler, a hotkey — is live in background tabs too and fires for
 * whatever the user is actually looking at. Gate such a listener on this hook
 * and the background copies go inert.
 *
 * Outside any surface (no `SurfaceIdContext`) the answer is `true`: a component
 * that is not in a tab has no background-tab ambiguity to resolve — it is
 * chrome, and chrome is always the thing on screen. Returning `false` there
 * would silently kill the very handlers this hook exists to keep honest.
 */
export function useSurfaceFocused(): boolean {
  const tabId = useSurfaceTabId();
  const { focusedTabId } = useTabs();
  return tabId === undefined || tabId === focusedTabId;
}
