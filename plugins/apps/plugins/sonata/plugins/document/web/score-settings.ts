import {
  defaultBassPattern,
  defaultChordPattern,
} from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import {
  DEFAULT_BASS_FIGURATION_ID,
  DEFAULT_BASS_VOICING,
  DEFAULT_CHORD_FIGURATION_ID,
  DEFAULT_CHORD_VOICING,
  type ReVoiceGroove,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import type { SwingOverride } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { defineSongSetting, type SongSetting } from "./song-setting";
import { useSettledSongSettings } from "./loaded-song";

/**
 * The per-song settings the document's score pipeline transforms the loaded
 * content with. Each is persisted by a feature plugin the document cannot
 * import (cycle), so the document DEFINES the setting — its identity, value
 * type and `absent` value — and the feature plugin registers it
 * (`SonataDocument.SongSetting`) with the observer that settles it; its
 * controls read and write it through `useSongSetting` / `useWriteSongSetting`.
 * Feature plugins depend on the document, never the reverse.
 *
 * This is the only place the document names them, and only because the
 * pipeline reads their VALUES. What the score waits for is not this list: it is every
 * setting the composition registers (`useSettledSongSettings`), so a
 * composition without one of these features loads without hanging, and the
 * pipeline reads that setting's `absent` value — the identity transform.
 */

/** Global transpose offset in semitones (`transpose` plugin). Absent: `0`. */
export const transposeSetting = defineSongSetting<number>("transpose", 0);

/**
 * "Auto-detect key" (`key-mode` plugin): when on, the pipeline ignores the
 * authored key and infers it from the notes. Absent: off.
 */
export const keyAutoDetectSetting = defineSongSetting<boolean>(
  "key auto-detect",
  false,
);

/**
 * Chord mode (`chord-mode` plugin): when on, the pipeline runs a second
 * re-voicing pass AFTER chord analysis, voicing the analyzer-derived chords
 * onto the synthesized Chords / Bass tracks. Absent: off.
 */
export const chordModeSetting = defineSongSetting<boolean>("chord mode", false);

/**
 * Per-song groove — the song's accompaniment: the two-hand onset necklace
 * (`hands`), each hand's tone-order figuration id
 * (`bassFigurationId`/`chordFigurationId`), each hand's voicing
 * (`bassVoicing`/`chordVoicing`: on/off, octave, voice-leading, octave
 * doubling) and whether a chord change starts the necklace over
 * (`restartOnChordChange`). The rhythm-grid (the *when*), the figuration (the
 * *what*) and the voicing (the *where*) are one accompaniment pattern, so they
 * travel together into `reVoiceChords`.
 */
export type RhythmGroove = ReVoiceGroove;

/**
 * The default accompaniment: a plain bass root and block chord, each struck
 * once per chord (one onset per cycle, restarting on every chord change) — what
 * a song plays before its groove is ever edited. Fresh on every call.
 */
export function defaultGroove(): RhythmGroove {
  return {
    hands: { bass: defaultBassPattern(), chord: defaultChordPattern() },
    bassFigurationId: DEFAULT_BASS_FIGURATION_ID,
    chordFigurationId: DEFAULT_CHORD_FIGURATION_ID,
    bassVoicing: DEFAULT_BASS_VOICING,
    chordVoicing: DEFAULT_CHORD_VOICING,
    restartOnChordChange: true,
  };
}

/**
 * The groove (`rhythm-controls` plugin). Every song's chords are played
 * through one — there is no groove-less path. Absent (a file document, or a
 * composition without the feature): the default accompaniment.
 */
export const grooveSetting = defineSongSetting<RhythmGroove>(
  "groove",
  defaultGroove(),
);

/**
 * The swing feel the song plays with (`swing` plugin): the content's own
 * (`score`), forced straight, or a chosen feel — applied to `meta.swing` as the
 * pipeline's last, meta-only step. Absent: the content's own.
 */
export const swingSetting = defineSongSetting<SwingOverride>("swing", {
  kind: "score",
});

/** The settings the score pipeline transforms the content with. */
export interface ScoreSettings {
  transposeSemitones: number;
  keyAutoDetect: boolean;
  groove: RhythmGroove;
  chordMode: boolean;
  swing: SwingOverride;
}

const SCORE_SETTINGS = {
  transposeSemitones: transposeSetting,
  keyAutoDetect: keyAutoDetectSetting,
  groove: grooveSetting,
  chordMode: chordModeSetting,
  swing: swingSetting,
};

/**
 * The loaded document's score settings — pending until every per-song setting the
 * composition registers has settled (the track view included, which the
 * pipeline does not read: that is what keeps every display and the audio engine
 * from showing or playing the song with default track views while they load).
 */
export function useScoreSettings(): SongSetting<ScoreSettings> {
  return useSettledSongSettings(SCORE_SETTINGS);
}
