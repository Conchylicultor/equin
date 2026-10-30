// The film's timeline as data: the music's beat grid in film time, and every
// section's window (seconds), each boundary on a beat so the cuts land on the
// music. Film t=0 is `PROMO_MUSIC.sectionStart` seconds into the track.

import { PROMO_MUSIC } from "../../deps";

export const DURATION = 64;

const BEAT = PROMO_MUSIC.beatSeconds;
/** Film time of beat 0: the first track beat at or after film t=0. */
const PHASE =
  (((PROMO_MUSIC.firstDownbeat - PROMO_MUSIC.sectionStart) % BEAT) + BEAT) %
  BEAT;

/** Film time of beat n (fractional n allowed), rounded to the millisecond. */
export const beat = (n: number): number =>
  Math.round((PHASE + n * BEAT) * 1000) / 1000;

export interface Section {
  id: string;
  from: number;
  to: number;
  /** Caption shown in the `--captions` variant; null = none. */
  caption: string | null;
}

/** The script's sections (Script v2), each cut on a beat. */
export const SECTIONS = {
  start: { id: "start", from: 0, to: beat(3), caption: null },
  anyApp: { id: "any-app", from: beat(3), to: beat(10), caption: "Any app" },
  integrated: {
    id: "integrated",
    from: beat(10),
    to: beat(24),
    caption: "All integrated",
  },
  moreApps: { id: "more-apps", from: beat(24), to: beat(28), caption: null },
  evolving: {
    id: "evolving",
    from: beat(28),
    to: beat(39),
    caption: "Evolves on request",
  },
  create: {
    id: "create",
    from: beat(39),
    to: beat(50),
    caption: "Create any app",
  },
  desktop: { id: "desktop", from: beat(50), to: beat(55), caption: null },
  mac: { id: "mac", from: beat(55), to: beat(61), caption: "On your Mac" },
  iceberg: {
    id: "iceberg",
    from: beat(61),
    to: beat(68),
    caption: "Hundreds more features",
  },
  github: {
    id: "github",
    from: beat(68),
    to: beat(70),
    caption: "Free and open source",
  },
  end: { id: "end", from: beat(70), to: DURATION, caption: null },
} as const satisfies Record<string, Section>;

export const SECTION_LIST: readonly Section[] = Object.values(SECTIONS);
