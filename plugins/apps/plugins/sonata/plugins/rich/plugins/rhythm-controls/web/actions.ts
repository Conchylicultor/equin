import { useCallback } from "react";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import type { RhythmPattern } from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import type { HandVoicing } from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import { setRhythmEndpoint } from "../shared/endpoints";

/**
 * The persisted groove: both hands' patterns, their figuration ids and
 * voicings, whether a chord change restarts the necklace, and the preset it was
 * applied from.
 */
export interface RhythmGroove {
  bass: RhythmPattern;
  chord: RhythmPattern;
  bassPatternId: string;
  chordPatternId: string;
  bassVoicing: HandVoicing;
  chordVoicing: HandVoicing;
  /** The groove preset this groove was applied from; `null` when none. */
  groovePresetId: string | null;
  restartOnChordChange: boolean;
}

/**
 * Copy a pattern into the plain wire shape — `onsets` is `readonly` on the core
 * type, while the endpoint body wants a mutable `number[]`.
 */
function wirePattern(p: RhythmPattern) {
  return {
    presetId: p.presetId,
    subdivisions: p.subdivisions,
    onsets: [...p.onsets],
    rotation: p.rotation,
  };
}

/**
 * Persist a song's groove.
 *
 * A rhythm edit (bead toggle, preset, rotation, subdivision) is a predicted
 * write: the `rhythms` row shows the groove at once and the server's row
 * confirms it; a rejection is toasted by the transport. The panel also writes
 * the loaded song's `grooveSetting` (instant playback + circle). Named `save*`
 * (not `set*`) to stay distinct from that in-memory write
 * (`useWriteSongSetting`).
 */
export function useSaveRhythm(): (
  songId: string,
  groove: RhythmGroove,
) => void {
  const { mutate } = useLiveMutation(setRhythmEndpoint);
  return useCallback(
    (songId, groove) =>
      mutate({
        params: { id: songId },
        body: {
          bass: wirePattern(groove.bass),
          chord: wirePattern(groove.chord),
          bassPatternId: groove.bassPatternId,
          chordPatternId: groove.chordPatternId,
          bassVoicing: groove.bassVoicing,
          chordVoicing: groove.chordVoicing,
          groovePresetId: groove.groovePresetId,
          restartOnChordChange: groove.restartOnChordChange,
        },
      }),
    [mutate],
  );
}
