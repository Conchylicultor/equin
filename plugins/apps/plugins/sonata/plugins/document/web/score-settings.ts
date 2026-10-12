import type { RhythmHands } from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import type { HandVoicing } from "@plugins/apps/plugins/sonata/plugins/voicing/core";
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
 * Per-song groove — the two-hand onset necklace (`hands`), each hand's
 * tone-order figuration id (`bassFigurationId`/`chordFigurationId`) and each
 * hand's voicing (`bassVoicing`/`chordVoicing`: on/off, octave, voice-leading,
 * octave doubling). The rhythm-grid (the *when*), the figuration (the *what*)
 * and the voicing (the *where*) are one accompaniment pattern, so they travel
 * together into `reVoiceChords`.
 */
export interface RhythmGroove {
  hands: RhythmHands;
  bassFigurationId: string;
  chordFigurationId: string;
  bassVoicing: HandVoicing;
  chordVoicing: HandVoicing;
}

/**
 * The groove (`rhythm-controls` plugin). A settled `null` ⇒ no groove ⇒ block
 * chords. Absent: `null`.
 */
export const grooveSetting = defineSongSetting<RhythmGroove | null>(
  "groove",
  null,
);

/** The settings the score pipeline transforms the content with. */
export interface ScoreSettings {
  transposeSemitones: number;
  keyAutoDetect: boolean;
  /** `null` ⇒ no groove (block chords). */
  groove: RhythmGroove | null;
  chordMode: boolean;
}

const SCORE_SETTINGS = {
  transposeSemitones: transposeSetting,
  keyAutoDetect: keyAutoDetectSetting,
  groove: grooveSetting,
  chordMode: chordModeSetting,
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
