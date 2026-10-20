import { useSyncExternalStore } from "react";
import { onStorageChange, storageUsage, type StoreUsage } from "./store";

// eslint-disable-next-line scoped-store/no-module-mutable-store -- Web Storage is one pool per origin: its usage is page-global by nature, the same for every surface
let snapshot: StoreUsage[] | null = null;

function subscribe(listener: () => void): () => void {
  return onStorageChange(() => {
    snapshot = null;
    listener();
  });
}

function getSnapshot(): StoreUsage[] {
  snapshot ??= storageUsage();
  return snapshot;
}

/** Every declared owner's footprint and counters, re-read on every change. */
export function useStorageUsage(): StoreUsage[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}
