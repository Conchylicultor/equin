import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import {
  DEFAULT_BASS_FIGURATION_ID,
  DEFAULT_BASS_VOICING,
  DEFAULT_CHORD_FIGURATION_ID,
  DEFAULT_CHORD_VOICING,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import { rhythmShape } from "../../shared/resources";

// Per-song rhythm groove attached to the library's `sonata_songs` row via the
// entity-extensions primitive (1:1 side-table, FK CASCADE on song delete).
// `enabled` gates the groove; `bass`/`chord` hold each hand's onset pattern and
// `bassPatternId`/`chordPatternId` each hand's figuration id and
// `bassVoicing`/`chordVoicing` each hand's voicing — see `rhythmShape`.
// The figuration ids and voicings default to today's sound so existing rows backfill without
// a groove change. An absent row reads as disabled (today's block-chord
// behavior). Owned here so the library schema stays stable and this feature is
// independently composable. Table: `sonata_songs_ext_rhythm`.
export const songRhythm = defineExtension(_songs, "rhythm", rhythmShape, {
  columns: {
    enabled: { default: false },
    bassPatternId: { default: DEFAULT_BASS_FIGURATION_ID },
    chordPatternId: { default: DEFAULT_CHORD_FIGURATION_ID },
    bassVoicing: { default: DEFAULT_BASS_VOICING },
    chordVoicing: { default: DEFAULT_CHORD_VOICING },
  },
});
export const _songRhythmExt = songRhythm.table; // drizzle-kit discovery
