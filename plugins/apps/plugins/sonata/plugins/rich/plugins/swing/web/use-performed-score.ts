import { useMemo } from "react";
import { useConfig } from "@plugins/config_v2/web";
import {
  swingScore,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { swingDisplayConfig } from "../shared/config";

/**
 * The score as the falling-note views draw it (the roll, its effects, the key
 * lights, the pedal lane): swung like the audio when the user's
 * `swingFallingNotes` is on, so a note meets the now-line when it sounds; the
 * straight `score` otherwise. The cursor stays on the straight axis — swing
 * moves beats only, never the tempo map, so a swung note's beat IS the cursor
 * beat it sounds at. Identity-stable for a song that plays straight.
 */
export function usePerformedScore(score: Score): Score {
  const { swingFallingNotes } = useConfig(swingDisplayConfig);
  return useMemo(
    () => (swingFallingNotes ? swingScore(score) : score),
    [swingFallingNotes, score],
  );
}
