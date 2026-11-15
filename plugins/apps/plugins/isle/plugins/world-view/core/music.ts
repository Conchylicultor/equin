import {
  ambientMoodOf,
  type AmbientMood,
} from "@plugins/music/plugins/ambient/core";
import type { DayPhase } from "./time-of-day";

/** The island's station: one mood held, or `auto` — the mood of the time of day. */
export type IsleStation = AmbientMood | "auto";

/** What each phase of the day plays while the station is `auto`. */
export const PHASE_MOOD: Readonly<Record<DayPhase, AmbientMood>> = {
  day: "lofi",
  dusk: "bossa",
  night: "nocturne",
};

/** Parses the stored station: `auto`, else a mood (anything else throws). */
export function isleStationOf(v: string): IsleStation {
  return v === "auto" ? "auto" : ambientMoodOf(v);
}

/** The mood the island plays for a station at a phase of the day. */
export function moodOf(station: IsleStation, phase: DayPhase): AmbientMood {
  return station === "auto" ? PHASE_MOOD[phase] : station;
}
