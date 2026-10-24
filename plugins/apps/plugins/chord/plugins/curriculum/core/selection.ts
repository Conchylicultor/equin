import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import {
  ChordTokenSchema,
  LoopExtrasSchema,
  chordTokenFromParts,
  type ChordToken,
  type LoopExtras,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { BlanksSchema, type Blanks } from "./blanks";

// ── What the learner has chosen ──────────────────────────────────────────
//
// Three settings, changed by the learner at any time: each chord's state, how
// much of the loop is blank, and how many chords that are off a loop may hold
// besides. It is what the trainer draws its loops, its answer buttons and its
// blanks from, so it is live: a change in one tab changes every open tab. The
// chords alone decide which loops fit, whatever key the song is labelled in.

/**
 * What a chord is to the learner:
 *
 * - `practice` — its boxes can be blank, and it has an answer button (or, when
 *   no track lists it, the Rare button answers it);
 * - `hear` — it can play in a loop, but its boxes are always given;
 * - `off` — a loop holding it plays only as one of the loop's `extras`.
 */
export const CHORD_STATES = ["practice", "hear", "off"] as const;
export const ChordStateSchema = z.enum(CHORD_STATES);
export type ChordState = z.infer<typeof ChordStateSchema>;

/** One chord that is on: `off` is simply not being listed. */
export const SelectedChordSchema = z.object({
  token: ChordTokenSchema,
  state: z.enum(["practice", "hear"]),
});
export type SelectedChord = z.infer<typeof SelectedChordSchema>;

export const SelectionSchema = z.object({
  /** Every chord that is not off, in token order. */
  chords: wholeList(SelectedChordSchema, {
    reason:
      "the chords the learner turned on — a subset of the catalog's chords",
  }),
  blanks: BlanksSchema,
  /** How many chords that are off a loop may hold besides ("Other chords per loop"). */
  extras: LoopExtrasSchema,
});
export type Selection = z.infer<typeof SelectionSchema>;

/** Where every learner starts: I, IV and V practised, the last half blank, no other chord. */
export function firstSelection(): Selection {
  const major = (root: number) =>
    chordTokenFromParts({ root, intervals: [4, 3], inversion: 0 });
  return canonicalSelection({
    chords: [0, 5, 7].map((root) => ({
      token: major(root),
      state: "practice" as const,
    })),
    blanks: "half",
    extras: 0,
  });
}

/** A chord's state in this selection. */
export function chordState(
  selection: Selection,
  token: ChordToken,
): ChordState {
  return selection.chords.find((c) => c.token === token)?.state ?? "off";
}

/** The chords whose boxes can be blank. */
export function practisedChords(selection: Selection): ChordToken[] {
  return selection.chords
    .filter((c) => c.state === "practice")
    .map((c) => c.token);
}

/** Every chord a loop may hold without counting as an extra: practised and heard. */
export function playableChords(selection: Selection): ChordToken[] {
  return selection.chords.map((c) => c.token);
}

/** The same selection in one canonical form: chords sorted by token. */
export function canonicalSelection(selection: {
  chords: readonly SelectedChord[];
  blanks: Blanks;
  extras: LoopExtras;
}): Selection {
  return {
    chords: [...selection.chords].sort((a, b) =>
      a.token < b.token ? -1 : a.token > b.token ? 1 : 0,
    ),
    blanks: selection.blanks,
    extras: selection.extras,
  };
}

/** Whether two selections say the same thing, whatever their order. */
export function sameSelection(a: Selection, b: Selection): boolean {
  return (
    JSON.stringify(canonicalSelection(a)) ===
    JSON.stringify(canonicalSelection(b))
  );
}
