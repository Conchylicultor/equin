import {
  useHasVoicedChords,
  useLibrarySong,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  ChordModeSwitch,
  useChordModeAvailable,
} from "@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-mode/web";
import { RhythmControls } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/rhythm-controls/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/**
 * Offered for a library song (a file document's accompaniment is the default
 * one, not editable) when chord mode can be flipped OR the song's chords are
 * voiced. Every hook runs unconditionally (rules of hooks).
 */
export function useAccompanimentAvailable(): boolean {
  const song = useLibrarySong();
  const chordModeAvailable = useChordModeAvailable();
  const voiced = useHasVoicedChords();
  return song.kind === "library" && (chordModeAvailable || voiced);
}

/**
 * Header action: the accompaniment's on/off — only for a song with detected
 * chords (a MIDI song), where it is chord mode. A song with authored chords
 * always plays its accompaniment: no switch.
 */
export function AccompanimentActions() {
  const chordModeAvailable = useChordModeAvailable();
  return chordModeAvailable ? <ChordModeSwitch /> : null;
}

/**
 * The Accompaniment body: the groove editor while the song's chords are
 * voiced — always for authored chords, and for detected chords while the
 * header switch (chord mode) is on. Off, a line says what the switch does.
 */
export function AccompanimentSection() {
  const voiced = useHasVoicedChords();
  if (voiced) return <RhythmControls />;
  return (
    <Text as="p" variant="body" tone="muted">
      Turn on to play the song's detected chords as an accompaniment.
    </Text>
  );
}
