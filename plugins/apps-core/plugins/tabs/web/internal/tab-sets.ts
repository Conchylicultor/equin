import { useSyncExternalStore } from "react";
import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";
import {
  getFocusedSurfaceId,
  setFocusedSurfaceId,
} from "@plugins/primitives/plugins/shortcuts/web";
import type { Placement } from "@plugins/apps-core/core";

/** The id of the page's own tab set — the app's surface. */
export const PAGE_TAB_SET_ID = "page";

/**
 * A mounted tab set as an out-of-tree caller sees it: a keyboard shortcut's
 * `when` / handler, a window command — code that runs from the window keydown
 * handler, outside every React subtree, and must act on the tab set the user
 * is in. Getters, never captured values: they read the provider's latest state.
 */
export interface TabSetHandle {
  /** {@link PAGE_TAB_SET_ID}, or `embed:<id>` for an `AppEmbed`'s. */
  readonly id: string;
  /** Rendered inside a box on the page (an embedded set), not the window. */
  readonly contained: boolean;
  /** The tab set's surface mode right now. */
  mode(): Placement;
  /** Whether `tabId` is one of its open tabs. */
  hasTab(tabId: string): boolean;
  /** Its focused tab right now (undefined on an empty surface). */
  focusedTabId(): string | undefined;
  /** Switch its surface mode (the Layout control, a window's Full screen). */
  setMode(mode: Placement): void;
  /** Return it to the mode before the current one (solo's exit). */
  exitToPreviousMode(): void;
  /**
   * The URL a new browser tab opened from inside it at in-app `path` loads:
   * the page's set writes it under its route prefix; an embed, as its host
   * addresses it (`EmbeddedTabSet.browserTabUrl`).
   */
  browserTabUrl(path: string): string;
}

// Keyed by tab-set id: every mounted `TabsProvider` (the page's, and each
// `AppEmbed`'s) registers itself for its lifetime. A registry of instances;
// what renders from it reads `useFocusedTabSet`, subscribed below.
const tabSets = new Map<string, TabSetHandle>();
// The tab set the user last acted in (it moved focus, or was pointed at): one
// fact per page, read from the window keydown handler. Each claim installs over
// the last; a claimed set that unmounts reads as the page's (below).
const activeTabSet = defineInstallSink<string>({
  name: "tabs.active-tab-set",
  what: "the tab set the user last acted in (claimed by its surface on pointer-down and by its provider on a focus change)",
  fallback: PAGE_TAB_SET_ID,
});

// Whoever renders from a tab set's state (`useFocusedTabSet`): told when a set
// mounts or unmounts, and when one's mode changes (`tabSetModeChanged`).
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Register a mounted tab set; the disposer removes it. */
export function registerTabSet(handle: TabSetHandle): () => void {
  tabSets.set(handle.id, handle);
  notify();
  return () => {
    if (tabSets.get(handle.id) === handle) tabSets.delete(handle.id);
    notify();
    // An embedded set leaving while it held the page's focused surface hands
    // it back to the page's set, so the page's surface shortcuts act again.
    const focused = getFocusedSurfaceId();
    if (handle.contained && focused !== undefined && handle.hasTab(focused))
      setFocusedSurfaceId(tabSets.get(PAGE_TAB_SET_ID)?.focusedTabId());
  };
}

/** The user is now in tab set `id` (it took focus, or was pointed at). */
export function claimTabSet(id: string): void {
  // A claim is never withdrawn — the next one supersedes it — so its disposer
  // is not kept.
  void activeTabSet.install(id);
}

/**
 * The tab set the user is in, for code outside every React subtree: the one
 * they last acted in — pointed at anywhere on its surface (a window, its shelf,
 * the bare desktop), or whose focus moved — else the page's. `undefined` only
 * before any tab set mounted. Inside a tab set, read `useTabs()` instead — it
 * is the set the component is in.
 */
export function peekFocusedTabSet(): TabSetHandle | undefined {
  return tabSets.get(activeTabSet.peek()) ?? tabSets.get(PAGE_TAB_SET_ID);
}

/** A registered tab set's mode changed: re-render whoever reads it. */
export function tabSetModeChanged(): void {
  notify();
}

/**
 * The tab set the user is in, for chrome outside it that acts on it (the
 * action bar's Layout control): {@link peekFocusedTabSet}'s answer, kept
 * current — re-rendered when the user moves to another set, when a set mounts
 * or unmounts, and when its mode changes. `undefined` before any set mounted.
 */
export function useFocusedTabSet(): {
  handle: TabSetHandle | undefined;
  mode: Placement | undefined;
} {
  const activeId = activeTabSet.useValue();
  const handle = useSyncExternalStore(
    subscribe,
    () => tabSets.get(activeId) ?? tabSets.get(PAGE_TAB_SET_ID),
  );
  const mode = useSyncExternalStore(subscribe, () => handle?.mode());
  return { handle, mode };
}
