import { z } from "zod";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { deriveUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import {
  HookpadKeySchema,
  HookpadMeterSchema,
  HookpadModeSchema,
  HookpadTempoSchema,
} from "@plugins/integrations/plugins/hooktheory/core";
// Straight from the core modules rather than the core barrel: drizzle-kit loads
// this file on its own, and the barrel also carries the endpoint contracts and
// the live value's declaration.
import { AlignmentSchema } from "../../core/beat-time";
import { IndexPhaseSchema } from "../../core/index-status";
import { LOOP_SHAPE_IDS } from "../../core/loop-shapes";
import { LoadScopeSchema } from "../../core/scope";
import { SkipSummarySchema } from "../../core/skip-tally";
import { StoredChordSchema } from "../../core/stored-chord";

// The song index. Three of these tables are a CACHE rebuilt from the snapshot
// file (`chord_sections`, `chord_loop_windows`, `chord_index_state`): left out of
// worktree forks, backups and the change feed. `chord_index_request` is the
// user's choice to use the app, and is kept everywhere.
//
// This file is a load-order leaf: it imports no other plugin's tables.

/** Where a section came from. Only the dump today; the Hooktheory API top-up is a later step. */
export const SectionSourceSchema = z.enum(["sheetsage-dump", "hooktheory-api"]);

/** One TheoryTab section that derivation kept (`deriveSection` → `indexed`). No melody. */
export const _chordSections = pgTable(
  "chord_sections",
  {
    /** The TheoryTab section id (`qveoYyGGodn`), shared by the dump and the API. */
    id: text("id").primaryKey(),
    source: parsedText("source", SectionSourceSchema).notNull(),
    /** Display names, from the raw dump's API record. */
    artist: text("artist").notNull(),
    song: text("song").notNull(),
    sectionName: text("section_name").notNull(),
    artistSlug: text("artist_slug").notNull(),
    songSlug: text("song_slug").notNull(),
    /** The playable YouTube id, or null when none was pasted or it is not a YouTube id. */
    videoId: text("video_id"),
    videoDurationSeconds: doublePrecision("video_duration_seconds"),
    alignment: parsedJson("alignment", AlignmentSchema).notNull(),
    keys: parsedJson("keys", z.array(HookpadKeySchema)).notNull(),
    meters: parsedJson("meters", z.array(HookpadMeterSchema)).notNull(),
    tempos: parsedJson("tempos", z.array(HookpadTempoSchema)).notNull(),
    endBeat: doublePrecision("end_beat").notNull(),
    /** Every Hookpad chord, compacted (`compactChord`), each sounding one with its token. */
    chords: parsedJson("chords", z.array(StoredChordSchema)).notNull(),
    /** Why the section has no windows at all, or null when it is loopable (it may still have none). */
    unloopableReason: parsedText(
      "unloopable_reason",
      z.enum(["no-video", "no-timing"]),
    ),
    sourceTags: text("source_tags").array().notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // The song-video lookup (`hooktheorySongVideos`): a song's sections by slug.
    index("chord_sections_artist_song_slug").on(t.artistSlug, t.songSlug),
  ],
);

/** The loops the trainer can play: derived from `chord_sections` by `LOOP_SHAPES`. */
export const _chordLoopWindows = pgTable(
  "chord_loop_windows",
  {
    sectionId: text("section_id")
      .notNull()
      .references(() => _chordSections.id, { onDelete: "cascade" }),
    shape: parsedText("shape", z.enum(LOOP_SHAPE_IDS)).notNull(),
    startBeat: doublePrecision("start_beat").notNull(),
    endBeat: doublePrecision("end_beat").notNull(),
    bars: integer("bars").notNull(),
    beatsPerBar: doublePrecision("beats_per_bar").notNull(),
    beatUnit: doublePrecision("beat_unit").notNull(),
    keyTonic: text("key_tonic").notNull(),
    keyMode: parsedText("key_mode", HookpadModeSchema).notNull(),
    /** The distinct sound tokens in the window. `@>` / `<@` / `&&` go through its GIN index. */
    chordTokens: text("chord_tokens").array().notNull(),
    /** The union of the window's spelling features (`CHORD_FEATURES`). */
    features: text("features").array().notNull(),
    chordCount: integer("chord_count").notNull(),
    changeCount: integer("change_count").notNull(),
    hasRest: boolean("has_rest").notNull(),
    startsOnChange: boolean("starts_on_change").notNull(),
    /**
     * `isRichLoop`, stored so `find` ranks on the one TS rule. The default only
     * fills rows written before the column existed: those are an older
     * derivation version, never read, and truncated by the reload it triggers.
     */
    rich: boolean("rich").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.sectionId, t.shape, t.startBeat] }),
    index("chord_loop_windows_chord_tokens_gin").using("gin", t.chordTokens),
    index("chord_loop_windows_features_gin").using("gin", t.features),
  ],
);

/** The one row id of the singleton tables below. */
export const SINGLETON_ROW_ID = 1;

/**
 * Where the loaded index stands: one row, written by the load job (which runs
 * in its own process, so the change feed is how the browser hears of it).
 * No row means no load has started on this database.
 */
export const _chordIndexState = deriveUpdatedAt(
  pgTable("chord_index_state", {
    id: integer("id").primaryKey(),
    phase: parsedText("phase", IndexPhaseSchema).notNull(),
    /** Sections loaded so far, during `loading`; the total loaded once `ready`. */
    done: integer("done"),
    /** Sections in scope in the snapshot, known once `loading` starts. */
    total: integer("total"),
    /** Loop windows loaded; set when `ready`. */
    windows: integer("windows"),
    error: text("error"),
    /** The snapshot file this load reads (`sheetsage-<processed>-<raw>-v<format>`): pins both dump sha256s and the line format. */
    snapshotName: text("snapshot_name").notNull(),
    scope: parsedText("scope", LoadScopeSchema).notNull(),
    derivationVersion: integer("derivation_version").notNull(),
    /** Sections left out, by reason (snapshot skips and derivation skips), with example ids. */
    skipped: parsedJson("skipped", SkipSummarySchema).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  }),
  {
    touchedBy: {
      phase: true,
      done: true,
      total: true,
      windows: true,
      error: true,
      snapshotName: true,
      scope: true,
      derivationVersion: true,
      skipped: true,
      startedAt: true,
      finishedAt: true,
      id: false,
    },
  },
);

/** "This instance uses the chord app": one row, written by `ensure`. Its presence is what lets boot reload a stale index. */
export const _chordIndexRequest = pgTable("chord_index_request", {
  id: integer("id").primaryKey(),
  requestedAt: timestamp("requested_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
