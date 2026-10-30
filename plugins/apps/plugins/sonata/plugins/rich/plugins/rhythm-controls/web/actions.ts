import { useCallback } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
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
 * A rhythm edit (bead toggle, preset, rotation, subdivision) is a **user-triggered
 * mutation**, so this goes through `useEndpointMutation` rather than a discarded
 * `void fetchEndpoint(...)`: a failed write must not vanish into a contextless
 * browser-rejection crash. Passing no `onError` opts into the global error toast,
 * so the user learns their groove did not save instead of silently losing it on
 * the next reload.
 *
 * The write is still *optimistic*: the panel writes the loaded song's
 * `grooveSetting` first (instant playback + circle), and the `rhythms` row push
 * re-affirms server truth. Named `save*` (not `set*`) to stay distinct from
 * that in-memory write (`useWriteSongSetting`).
 */
export function useSaveRhythm(): (
  songId: string,
  groove: RhythmGroove,
) => void {
  const { mutate } = useEndpointMutation(setRhythmEndpoint);
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
