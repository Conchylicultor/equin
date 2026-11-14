/**
 * The moods the ambient engine plays — a closed list, so a config's options
 * and the engine's songs cannot disagree.
 */
export const AMBIENT_MOODS = ["lofi", "ambient"] as const;
export type AmbientMood = (typeof AMBIENT_MOODS)[number];

/** Each mood as a radio would name it: its track, then its kind. */
export const AMBIENT_TRACKS: Readonly<Record<AmbientMood, string>> = {
  lofi: "afternoon tea · lofi",
  ambient: "tide pools · ambient",
};

/** A mood's label for a picker. */
export const AMBIENT_MOOD_LABELS: Readonly<Record<AmbientMood, string>> = {
  lofi: "Lo-fi",
  ambient: "Ambient",
};

/** Parses a stored mood: a value outside the list is a bug upstream, so it throws. */
export function ambientMoodOf(v: string): AmbientMood {
  const m = AMBIENT_MOODS.find((x) => x === v);
  if (!m) throw new Error(`ambient: unknown mood "${v}"`);
  return m;
}
