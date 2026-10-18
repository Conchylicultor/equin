import {
  chordModeSetting,
  useHasChords,
  useHasOwnNotes,
  useSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";

/**
 * The chord-mode switch is offered when the song plays notes of its own and has
 * chords to voice over them — detected (a MIDI song) or authored (a score's
 * chord symbols, a transcription) — or when the mode is already on, so a stale
 * "on" (say, after the song's MIDI was re-imported and detection now finds
 * nothing) can always be switched off. A chord-only song always plays its
 * accompaniment and has no switch.
 * While the mode is pending the song's settings are still loading, so the score
 * is empty and there is no switch to offer yet; a failed read leaves the score
 * empty too, and the player's score gate shows that failure.
 */
export function useChordModeAvailable(): boolean {
  const ownNotes = useHasOwnNotes();
  const hasChords = useHasChords();
  const enabled = useSongSetting(chordModeSetting);
  switch (enabled.kind) {
    case "pending":
    case "failed":
      return false;
    case "settled":
      return (ownNotes && hasChords) || enabled.value;
  }
}
