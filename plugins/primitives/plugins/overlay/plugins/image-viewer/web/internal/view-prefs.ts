import {
  legacyDraftKeys,
  readDraft,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { TILE_DEFAULT, clampTile } from "../../core";

/**
 * The two viewer choices that outlive one open, on this device: whether the
 * thumbnail strip is docked, and how large the grid's tiles are. The layout
 * (single / grid) and the slideshow start fresh on every open.
 */
export interface ViewPrefs {
  readonly strip: boolean;
  readonly tile: number;
}

/** A preference, not a draft: kept for a year of not opening the viewer. */
const prefsStore = defineStore({
  owner: "image-viewer.prefs",
  label: "Image viewer preferences",
  area: "local",
  cap: "4 KB",
  ttl: 365 * 24 * 60 * 60 * 1000,
  whenFull: "refuse",
  schema: z.object({ strip: z.boolean(), tile: z.number() }),
  legacy: legacyDraftKeys("image-viewer:prefs"),
});

export function readViewPrefs(): ViewPrefs {
  const raw = readDraft(prefsStore);
  return {
    strip: raw?.strip ?? false,
    tile: raw === null ? TILE_DEFAULT : clampTile(raw.tile),
  };
}

export function writeViewPrefs(prefs: ViewPrefs): void {
  writeDraft(prefsStore, prefs);
}
