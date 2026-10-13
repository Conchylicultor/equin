import {
  chordModeSetting,
  useHasDerivedChord,
  useSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";

/**
 * The chord-mode switch is offered when the song has detected chords to voice — or
 * when the mode is already on, so a stale "on" (say, after the song's MIDI was
 * re-imported and detection now finds nothing) can always be switched off.
 * While the mode is pending the song's settings are still loading, so the score
 * is empty and there is no switch to offer yet; a failed read leaves the score
 * empty too, and the player's score gate shows that failure.
 */
export function useChordModeAvailable(): boolean {
  const hasDerived = useHasDerivedChord();
  const enabled = useSongSetting(chordModeSetting);
  switch (enabled.kind) {
    case "pending":
    case "failed":
      return false;
    case "settled":
      return hasDerived || enabled.value;
  }
}
