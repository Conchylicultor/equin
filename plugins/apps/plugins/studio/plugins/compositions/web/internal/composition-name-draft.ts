import { z } from "zod";
import { defineKept } from "@plugins/primitives/plugins/kept-state/web";

/**
 * A composition's unsaved rename, kept per composition id: the seed
 * (`useSeedActiveComposition`) lays it over the saved manifest, and the detail
 * pane's name field writes it. Cleared on Save, Clear and Delete.
 *
 * Only the name is kept: the rest of the active draft (entry points, selected
 * contributors) still lives in the memory-only active-composition store.
 */
export const compositionNameDraft = defineKept({
  owner: "studio.compositions.name",
  label: "Composition name drafts",
  tier: "work",
  stamp: "nl1v68s27p",
  cap: "16 KB",
  schema: z.string(),
});
