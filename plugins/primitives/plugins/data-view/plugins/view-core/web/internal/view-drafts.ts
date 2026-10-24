import { z } from "zod";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
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

/**
 * The tab's drafts per surface, as last written or read. Module-level so every
 * mount of one surface reads the SAME map (and the same draft objects — the
 * getters downstream key their memos on them) and an edit made in one is seen
 * by the others through the store's subscription. sessionStorage is the tab's
 * own, so nothing but this module writes it while the page lives.
 */
const cache = new Map<string, DraftMap>();

/** The surface's drafts: the in-memory map, read from storage on first use. */
export function readDrafts(storageKey: string): DraftMap {
  const held = cache.get(storageKey);
  if (held !== undefined) return held;
  const read = viewDrafts.read(storageKey);
  const map: DraftMap =
    read.kind === "value"
      ? (read.value as Record<string, VariantValue>)
      : EMPTY;
  cache.set(storageKey, map);
  return map;
}

/** Replace the surface's drafts: memory first (what every reader sees), then
 *  storage — an empty map removes the entry rather than storing `{}`. */
export function writeDrafts(storageKey: string, next: DraftMap): void {
  cache.set(storageKey, next);
  if (Object.keys(next).length === 0) viewDrafts.remove(storageKey);
  else viewDrafts.write(storageKey, next);
}

/** Notify on every write to the surface's drafts (from any mount in this tab). */
export function subscribeDrafts(
  storageKey: string,
  onChange: () => void,
): () => void {
  return viewDrafts.subscribe(storageKey, onChange);
}
