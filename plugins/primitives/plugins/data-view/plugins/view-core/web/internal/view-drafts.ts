import { z } from "zod";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { useMemo } from "react";
import {
  defineStore,
  useStore,
  type Store,
  isKeyInScope,
  onStorageScopeCleared,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import type { DraftMap } from "./draft-values";

/**
 * Per browser tab, like the search query (`data-view.view-queries`): a draft is
 * an edit in progress, and a new tab or a browser restart starts from the saved
 * views. F5 keeps it. `refuse` when full — a draft is what the user did, never
 * a cache to evict; a refused write is announced and lives on in memory.
 */
const viewDrafts = defineStore({
  owner: "data-view.view-drafts",
  label: "Unsaved view edits",
  area: "session",
  cap: "256 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.record(z.string(), z.object({ type: z.string() }).passthrough()),
});

const EMPTY: DraftMap = Object.freeze({});

type DraftStore = Store<Record<string, { type: string }>>;

/**
 * The tab's drafts per surface (and composition scope — the store's full key),
 * as last written or read. Module-level so every mount of one surface reads the
 * SAME map (and the same draft objects — the getters downstream key their
 * memos on them) and an edit made in one is seen by the others through the
 * store's subscription. sessionStorage is the tab's own, so nothing but this
 * module writes it while the page lives.
 */
const cache = new Map<string, DraftMap>();
// A wiped scope (the demo's Reset) takes its drafts with it, here too.
onStorageScopeCleared((id) => {
  for (const key of [...cache.keys()])
    if (isKeyInScope(key, id)) cache.delete(key);
});

/** One surface's drafts, in the composition scope the caller renders in. */
export interface SurfaceDrafts {
  /** The surface's drafts: the in-memory map, read from storage on first use. */
  read(): DraftMap;
  /** Replace the surface's drafts: memory first (what every reader sees), then
   *  storage — an empty map removes the entry rather than storing `{}`. */
  write(next: DraftMap): void;
  /** Notify on every write to the surface's drafts (from any mount in this tab). */
  subscribe(onChange: () => void): () => void;
}

function surfaceDrafts(store: DraftStore, storageKey: string): SurfaceDrafts {
  const key = store.key(storageKey);
  return {
    read() {
      const held = cache.get(key);
      if (held !== undefined) return held;
      const read = store.read(storageKey);
      const map: DraftMap =
        read.kind === "value"
          ? (read.value as Record<string, VariantValue>)
          : EMPTY;
      cache.set(key, map);
      return map;
    },
    write(next) {
      cache.set(key, next);
      if (Object.keys(next).length === 0) store.remove(storageKey);
      else store.write(storageKey, next);
    },
    subscribe: (onChange) => store.subscribe(storageKey, onChange),
  };
}

/** The drafts of the surface `storageKey`, where this renders (stable per surface and scope). */
export function useSurfaceDrafts(storageKey: string): SurfaceDrafts {
  const store = useStore(viewDrafts);
  return useMemo(() => surfaceDrafts(store, storageKey), [store, storageKey]);
}
