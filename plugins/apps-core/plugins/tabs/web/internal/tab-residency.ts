import { useState } from "react";

/**
 * How many hidden tabs stay mounted beside the ones on screen: the most
 * recently focused ones, so switching back to a tab you just left is instant.
 * Every other hidden tab is unloaded. Each mounted tab holds its whole app — a
 * conversation ~110 MB, Sonata ~600 MB (research/2026-11-11-global-browser-tab-memory.md §2)
 * — so this bounds a browser tab's memory by what is open NOW, not by every
 * in-app tab ever opened in it.
 */
export const KEPT_HIDDEN_TABS = 2;

/**
 * Which tabs of a tab set are mounted ("resident"): every tab on screen, plus
 * the {@link KEPT_HIDDEN_TABS} most recently focused hidden ones. A tab outside
 * the set is unloaded — its app subtree unmounts (DOM, React state, live
 * subscriptions) while the tab itself stays: its pane store (route, pane
 * instances), its title. Focusing it mounts it again from that store, as a
 * reload would; drafts and scroll offsets come back through their own
 * persistence (`persistent-draft`, `useScrollAcrossReload` under
 * `ScrollRevival`).
 *
 * Recency is what THIS surface has seen focused, newest first. A tab set booted
 * from storage starts with only its focused tab resident: a reload mounts the
 * tab you look at, and every other tab mounts when you first open it.
 *
 * `tabIds` is every tab the surface renders (exiting ones included, so a tab
 * playing its exit tween keeps what it had); `onScreen` says which are painted
 * now (the focused one, every window of a mode that shows unfocused tabs).
 */
export function useResidentTabs(
  tabIds: readonly string[],
  onScreen: (tabId: string) => boolean,
  focusedTabId: string | undefined,
): ReadonlySet<string> {
  // Most-recently-focused first. Adjusted during render (React's
  // adjust-state-on-input pattern), so the commit that focuses a tab already
  // mounts it.
  const [recent, setRecent] = useState<readonly string[]>(() =>
    focusedTabId === undefined ? [] : [focusedTabId],
  );
  const present = new Set(tabIds);
  const next = nextRecency(recent, present, focusedTabId);
  if (next !== recent) setRecent(next);

  return residentTabs(next, tabIds, onScreen);
}

/**
 * The resident set for a recency list (newest first): every tab on screen,
 * plus the first {@link KEPT_HIDDEN_TABS} hidden ones in recency order.
 */
export function residentTabs(
  recent: readonly string[],
  tabIds: readonly string[],
  onScreen: (tabId: string) => boolean,
): ReadonlySet<string> {
  const resident = new Set<string>();
  for (const id of tabIds) if (onScreen(id)) resident.add(id);
  let hiddenKept = 0;
  for (const id of recent) {
    if (hiddenKept >= KEPT_HIDDEN_TABS) break;
    if (resident.has(id)) continue;
    resident.add(id);
    hiddenKept++;
  }
  return resident;
}

/**
 * The recency list after a render: the focused tab moved to the front, tabs no
 * longer rendered dropped. Returns `recent` itself when nothing changed, so the
 * render-time update settles.
 */
export function nextRecency(
  recent: readonly string[],
  present: ReadonlySet<string>,
  focusedTabId: string | undefined,
): readonly string[] {
  const kept = recent.filter((id) => present.has(id) && id !== focusedTabId);
  const next =
    focusedTabId !== undefined && present.has(focusedTabId)
      ? [focusedTabId, ...kept]
      : kept;
  return next.length === recent.length &&
    next.every((id, i) => id === recent[i])
    ? recent
    : next;
}
