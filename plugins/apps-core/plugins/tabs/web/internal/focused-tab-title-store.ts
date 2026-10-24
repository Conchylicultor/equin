import { useSyncExternalStore } from "react";

// The focused tab's resolved content title (the selected page, conversation,
// song …) — a page-global signal beside `focusedApp`, for what renders OUTSIDE
// `TabsProvider` and so cannot call `useTabs()` (a `Core.Root` host: the Ask
// equin card attaches it to a question). `TabsProvider` publishes it on every
// focus or title change. `undefined` is a real answer, not "unknown": the
// focused tab is at its app index, or its pane has no title (the tab bar then
// shows the app's name).
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: exactly one tab is focused per page; mirrors focusedApp. Published by the single TabsProvider, read by Core.Root hosts outside any per-surface tree.
let focusedTabTitle: string | undefined;
const listeners = new Set<() => void>();

/** Publish the focused tab's content title (or clear it with `undefined`). */
export function setFocusedTabTitle(title: string | undefined): void {
  if (title === focusedTabTitle) return;
  focusedTabTitle = title;
  for (const l of listeners) l();
}

function getFocusedTabTitle(): string | undefined {
  return focusedTabTitle;
}

function subscribeFocusedTabTitle(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Reactive read of the focused tab's content title, from anywhere on the page
 * (inside or outside `TabsProvider`). `undefined` while the focused tab shows
 * its app's index or an untitled pane.
 */
export function useFocusedTabTitle(): string | undefined {
  return useSyncExternalStore(
    subscribeFocusedTabTitle,
    getFocusedTabTitle,
    () => undefined,
  );
}
