import {
  useHasVoicedChords,
  useLibrarySong,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  ChordModeRow,
  useChordModeAvailable,
} from "@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-mode/web";
import {
  GrooveSwitch,
  RhythmControls,
  useGroove,
} from "@plugins/apps/plugins/sonata/plugins/rich/plugins/rhythm-controls/web";
import { VoicingControls } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/voicing-controls/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Separator } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * Offered when chord mode can be flipped OR the song's chords are voiced. Both
 * hooks run unconditionally (rules of hooks).
 */
export function useAccompanimentAvailable(): boolean {
  const chordModeAvailable = useChordModeAvailable();
  const voiced = useHasVoicedChords();
  return chordModeAvailable || voiced;
}

/** Header action: the groove switch, only while there are voiced chords to groove. */
export function AccompanimentActions() {
  const voiced = useHasVoicedChords();
  return voiced ? <GrooveSwitch /> : null;
}

/**
 * The Accompaniment body: the chord-mode row, then (when the song's chords are
 * voiced) EITHER the groove body — whose hands carry their own octave and
 * voice-leading — OR, while the groove is off, the block-chord voicing rows.
 * Never both: the two voice the chords on different paths, so showing both
 * would offer two Octave controls of which one does nothing.
 */
export function AccompanimentSection() {
  const chordModeAvailable = useChordModeAvailable();
  const voiced = useHasVoicedChords();
  const part = useVoicedPart();

  return (
    <Stack gap="md">
      {chordModeAvailable && <ChordModeRow />}
      {chordModeAvailable && voiced && <Separator />}
      {voiced && part === "groove" && <RhythmControls />}
      {voiced && part === "voicing" && <VoicingControls />}
    </Stack>
  );
}

/**
 * Which voiced part the body shows. A file document has no groove, so its
 * chords are block chords: the voicing rows. A library song shows the groove
 * body while its groove is on — or not known yet (the body's loading / error
 * state) — and the voicing rows once it is known to be off.
 */
function useVoicedPart(): "groove" | "voicing" {
  const song = useLibrarySong();
  const groove = useGroove();
  if (song.kind === "none") return "voicing";
  if (groove.status !== "ready") return "groove";
  return groove.data.enabled ? "groove" : "voicing";
}
