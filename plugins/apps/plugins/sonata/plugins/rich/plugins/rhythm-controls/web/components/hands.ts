import { useMemo } from "react";
import type { SongSetting } from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  accidentalColor,
  useTrackMixerEntries,
} from "@plugins/apps/plugins/sonata/plugins/track-mixer/web";
import {
  CHORD_BASS_TRACK,
  CHORD_TRACK,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";

/** The two hands of a groove: the right hand plays the chords, the left the bass. */
export type Hand = "chord" | "bass";

/**
 * Each hand's name and the generated track it plays on — so its colour dot,
 * its ring on the circle and its track in the mixer are one colour, and its
 * header can name that track.
 */
export const HANDS: Record<Hand, { label: string; trackId: string }> = {
  chord: { label: "Right hand", trackId: CHORD_TRACK },
  bass: { label: "Left hand", trackId: CHORD_BASS_TRACK },
};

/**
 * A hand's track as the mixer shows it: its name and its swatch's colour (the
 * mixer paints a swatch in the track colour's `accidentalColor` shade).
 */
export interface HandTrack {
  name: string;
  color: string;
}

/**
 * Each hand's track, read from the mixer (the user's colour, the track's
 * name). Pending / failed with the mixer's own state. A hand whose track is not
 * in the score yet (no chord voiced onto it) reads its hand name in the neutral
 * foreground — a colour of chrome, not a claim about the track.
 */
export function useHandTracks(): SongSetting<Record<Hand, HandTrack>> {
  const entries = useTrackMixerEntries();
  return useMemo(() => {
    if (entries.kind !== "settled") return entries;
    const track = (hand: Hand): HandTrack => {
      const entry = entries.value.find(
        (e) => e.trackId === HANDS[hand].trackId,
      );
      return entry
        ? { name: entry.name, color: accidentalColor(entry.color) }
        : { name: HANDS[hand].label, color: "var(--muted-foreground)" };
    };
    return {
      kind: "settled",
      value: { chord: track("chord"), bass: track("bass") },
    };
  }, [entries]);
}
