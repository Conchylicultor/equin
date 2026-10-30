import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { LoopExtrasSchema } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { BlanksSchema } from "./blanks";
import { ChordChangeSchema } from "./change";

// ── Changing the selection ───────────────────────────────────────────────────
//
// Three writes, each one transaction. None answers with the new selection: the
// live `chord.curriculum` resource pushes it to every open tab.

/** Most chord changes one write carries: more than the catalog's every chord. */
export const MAX_CHORD_CHANGES = 5000;

/**
 * Set chords to practise, hear only, or off, applied in order: one chip, a
 * section, a rare group, Clear, or the Undo of a Clear.
 */
export const setChordsEndpoint = defineEndpoint({
  route: "POST /api/chord/curriculum/chords",
  body: z.object({
    changes: z.array(ChordChangeSchema).min(1).max(MAX_CHORD_CHANGES),
  }),
});

/** How much of the loop is blank. */
export const setBlanksEndpoint = defineEndpoint({
  route: "POST /api/chord/curriculum/blanks",
  body: z.object({ blanks: BlanksSchema }),
});

/** How many chords that are off a loop may hold besides. */
export const setExtrasEndpoint = defineEndpoint({
  route: "POST /api/chord/curriculum/extras",
  body: z.object({ extras: LoopExtrasSchema }),
});
