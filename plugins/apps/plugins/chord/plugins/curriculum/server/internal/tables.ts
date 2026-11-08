import { z } from "zod";
import { integer, pgTable } from "drizzle-orm/pg-core";
import {
  deriveUpdatedAt,
  derivedUpdatedAt,
} from "@plugins/database/plugins/derived-updated-at/server";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import { LoopExtrasSchema } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { RecordedBlanksSchema } from "../../core/blanks";
import { SelectedChordSchema } from "../../core/selection";

// What the learner has chosen: one row, written only when they change a
// setting. It is theirs and nothing can rebuild it, so it is KEPT in worktree
// forks and backups, and stays in the change feed, which is what pushes
// `chord.curriculum`. No growth bound: it is one row, always. See the plugin's
// CLAUDE.md.
//
// No row yet means nobody has changed anything: the loader answers
// `firstSelection()` and the first write inserts the row.
//
// This file is a load-order leaf (drizzle-kit loads it on its own), so it
// imports its schemas from their core modules directly, never through the
// core barrel.

export const _chordCurriculum = deriveUpdatedAt(
  pgTable("chord_curriculum", {
    /** Always 1: there is one learner per instance, so one selection. */
    id: integer("id").primaryKey(),
    /** Every chord that is not off, and whether it is practised or only heard. */
    chords: parsedJson("chords", z.array(SelectedChordSchema)).notNull(),
    /**
     * How much of a loop is blank. A row written before the path went may
     * still hold `one`, which the loader reads as `half`: the column takes
     * every recorded value, the selection only the settable ones.
     */
    blanks: parsedText("blanks", RecordedBlanksSchema).notNull(),
    /** How many chords that are off a loop may hold besides: 0, 1, 2 or "any". */
    extras: parsedJson("extras", LoopExtrasSchema).notNull().default(0),
    updatedAt: derivedUpdatedAt(),
  }),
  { touchedBy: { chords: true, blanks: true, extras: true, id: false } },
);
