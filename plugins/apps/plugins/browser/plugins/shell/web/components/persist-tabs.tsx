import { useEffect } from "react";
import { BrowserTabsStore } from "../nav-store";
import { SAVED_TABS_ID, savedTabs } from "../internal/saved-tabs";
import { mergeSaved, toSaved } from "../internal/saved-tabs-model";

/**
 * Keeps this surface's tabs and the saved tab set one: every change here is
 * saved, and a set saved by another surface (this page or another) is merged
 * in by key. The last JSON seen either way stops the echo of its own write.
 * The merge itself is not saved back: the saved `activeKey` stays the tab last
 * selected anywhere, and two surfaces never trade their selections forever.
 * Renders nothing; mounted inside `<BrowserTabsStore.Provider>`.
 */
export function PersistBrowserTabs() {
  const store = BrowserTabsStore.useStoreApi();

  useEffect(() => {
    const initial = savedTabs.read(SAVED_TABS_ID);
    let last = initial.kind === "value" ? JSON.stringify(initial.value) : "";
    let adopting = false;

    const save = () => {
      if (adopting) return;
      const saved = toSaved(store.getState());
      const json = JSON.stringify(saved);
      if (json === last) return;
      last = json;
      // A refused write is announced by web-storage itself (toast, health row).
      savedTabs.write(SAVED_TABS_ID, saved);
    };

    const adopt = () => {
      const read = savedTabs.read(SAVED_TABS_ID);
      if (read.kind !== "value") return;
      const json = JSON.stringify(read.value);
      if (json === last) return;
      last = json;
      adopting = true;
      try {
        store.setState((s) => mergeSaved(s, read.value));
      } finally {
        adopting = false;
      }
    };

    save();
    const unsubscribeStore = store.subscribe(save);
    const unsubscribeSaved = savedTabs.subscribe(SAVED_TABS_ID, adopt);
    return () => {
      unsubscribeStore();
      unsubscribeSaved();
    };
  }, [store]);

  return null;
}
