import {
  defineStore,
  useStore,
  type Store,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { SavedTabsSchema, type SavedTabs } from "./saved-tabs-model";

/**
 * The browser's tab set, saved in this browser's `localStorage` under one
 * entry ({@link SAVED_TABS_ID}): restored by every surface the Browser app
 * mounts (a reload, a new window, switching back to the app), and kept in sync
 * between surfaces open at once. What the user arranged, so a write over the
 * cap is refused loudly rather than evicting it.
 */
const savedTabs = defineStore({
  owner: "apps.browser.tabs",
  label: "Browser tabs",
  area: "local",
  cap: "128 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: SavedTabsSchema,
});

export const SAVED_TABS_ID = "tabs";

/** The saved tab set's store, in the composition scope this renders in. */
export function useSavedTabs(): Store<SavedTabs> {
  return useStore(savedTabs);
}

/** A page another surface holds, handed to the browser's tab set. */
export interface BrowserTabHandoff {
  /** The remote page's key on the engine host. */
  key: string;
  url: string;
  title: string;
}

/**
 * Adds a page to the browser's saved tab set and makes it the tab a newly
 * mounted Browser surface selects — the page itself (its key), not a copy, so
 * its history and state come along. A page already in the set is only
 * selected. A surface already showing the Browser merges it in by key.
 */
export function useAddBrowserTab(): (page: BrowserTabHandoff) => void {
  const saved = useSavedTabs();
  return (page) => {
    const read = saved.read(SAVED_TABS_ID);
    // A set this build cannot read (another build's schema, storage off) is
    // never written over: the user's tabs outrank one handed-off page.
    if (
      read.kind === "none" &&
      (read.why === "other-schema" || read.why === "unavailable")
    ) {
      throw new Error(
        `Cannot add the page to the browser's tabs: the saved tab set is ${read.why}`,
      );
    }
    const tabs = read.kind === "value" ? read.value.tabs : [];
    const next: SavedTabs = {
      tabs: tabs.some((t) => t.key === page.key)
        ? tabs
        : [
            ...tabs,
            {
              key: page.key,
              url: page.url,
              pageUrl: page.url,
              title: page.title,
              faviconUrl: null,
            },
          ],
      activeKey: page.key,
    };
    // A refused write is announced by web-storage itself (toast, health row).
    saved.write(SAVED_TABS_ID, next);
  };
}
