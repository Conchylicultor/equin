import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchValue } from "@plugins/network/plugins/live/core";
import { LoopExtrasSchema } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { BlanksSchema } from "./blanks";
import {
  ChordChangeSchema,
  withBlanks,
  withChordChanges,
  withExtras,
} from "./change";
import { chordCurriculum } from "./resource";

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
  // The same pure reducer the server applies to the stored selection.
  effect: (on) =>
    patchValue(
      on,
      chordCurriculum,
      () => ({}),
      (sel, { body }) => withChordChanges(sel, body.changes),
    ),
});

/** How much of the loop is blank. */
export const setBlanksEndpoint = defineEndpoint({
  route: "POST /api/chord/curriculum/blanks",
  body: z.object({ blanks: BlanksSchema }),
  // The same pure reducer the server applies to the stored selection.
  effect: (on) =>
    patchValue(
      on,
      chordCurriculum,
      () => ({}),
      (sel, { body }) => withBlanks(sel, body.blanks),
    ),
});

/** How many chords that are off a loop may hold besides. */
export const setExtrasEndpoint = defineEndpoint({
  route: "POST /api/chord/curriculum/extras",
  body: z.object({ extras: LoopExtrasSchema }),
  // The same pure reducer the server applies to the stored selection.
  effect: (on) =>
    patchValue(
      on,
      chordCurriculum,
      () => ({}),
      (sel, { body }) => withExtras(sel, body.extras),
    ),
});
