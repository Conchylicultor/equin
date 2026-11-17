import { useEffect } from "react";
import { useConfig } from "@plugins/config_v2/web";
import {
  AMBIENT_TRACKS,
  type AmbientMood,
} from "@plugins/music/plugins/ambient/core";
import { createAmbientHost } from "@plugins/music/plugins/ambient/web";
import type { BackgroundMusicPlayerProps } from "@plugins/music/plugins/background/web";
import { isleConfig, isleStationOf, moodOf } from "../../core";
import { useTimeOfDay } from "./time";
import { timeOf } from "./use-isle-world";

/**
 * The island's music engine, one for the page: the island view holds it for
 * its sound effects and its warm-up (the context built while the island
 * loads, so Start only resumes it), and the background music service plays
 * it from the page root — so the music can outlive the island.
 */
export const isleAmbient = createAmbientHost();

/** The mood the island plays now: the radio's station, or the time of day's. */
function useIsleMood(): AmbientMood {
  const { time, mood } = useConfig(isleConfig);
  const phase = useTimeOfDay(timeOf(time));
  return moodOf(isleStationOf(mood), phase);
}

/** The island's track, in words (the radio's label). */
export function useIsleTitle(): string {
  return AMBIENT_TRACKS[useIsleMood()];
}

/**
 * The island's background music player, run by the service at the page root:
 * plays the island's mood while `playing`, at the listener's volume, and
 * keeps following the time of day while nobody looks at the island.
 */
export function useIslePlayer({ playing, gain }: BackgroundMusicPlayerProps) {
  const mood = useIsleMood();
  useEffect(() => {
    const release = isleAmbient.retain();
    return () => {
      // the island's view may still hold the engine: the music stops with
      // its player all the same
      isleAmbient.set({ on: false });
      release();
    };
  }, []);
  useEffect(() => isleAmbient.set({ on: playing, mood }), [playing, mood]);
  useEffect(() => isleAmbient.setGain(gain), [gain]);
}
