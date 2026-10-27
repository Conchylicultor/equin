import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { SavedTabsSchema } from "./saved-tabs-model";

/**
 * The browser's tab set, saved in this browser's `localStorage` under one
 * entry ({@link SAVED_TABS_ID}): restored by every surface the Browser app
 * mounts (a reload, a new window, switching back to the app), and kept in sync
 * between surfaces open at once. What the user arranged, so a write over the
 * cap is refused loudly rather than evicting it.
 */
export const savedTabs = defineStore({
  owner: "apps.browser.tabs",
  label: "Browser tabs",
  area: "local",
  cap: "128 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: SavedTabsSchema,
});

export const SAVED_TABS_ID = "tabs";
