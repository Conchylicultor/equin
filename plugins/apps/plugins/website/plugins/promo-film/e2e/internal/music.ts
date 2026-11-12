// The film's music — THE one place to swap it. The cut does not depend on the
// track (sections follow the recordings, not a beat grid), so changing this
// constant and re-running film.ts re-renders with the new track; nothing is
// recorded again.
//
// - `{ kind: "dep" }`: the pinned, license-checked `promo-music` dep
//   (../../deps), installed on demand.
// - `{ kind: "file", path, sectionStart }`: any local file (an audition).
//
// Now: a PLACEHOLDER while the user auditions candidates — #11, "Can't Stop My
// Feet!" by Loyalty Freak Music (album ROLLER DISCO DANCE DANCE, 2018,
// archive.org/details/LoyaltyFreakMusic-ROLLERDISCODANCEDANCE), from its start,
// exactly as the 64 s preview the user heard. Once picked, pin it as the
// `promo-music` dep (sha256, license) and switch this to `{ kind: "dep" }`.

import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { downloadedFile } from "@plugins/infra/plugins/deps/plugins/download/deps";
import { PROMO_MUSIC, promoMusic } from "../../deps";

/**
 * The track's beat grid, measured from the file (onset-envelope
 * autocorrelation for the tempo, then the phase whose beats sum the most
 * onset): `firstBeat` s into the file, a beat every 60 / `bpm` s. The film
 * lands the closing montage and the end card on it (film.ts); without one the
 * cut ignores the music.
 */
export interface BeatGrid {
  bpm: number;
  firstBeat: number;
  /**
   * How the track divides its beat — the grid the montage cuts on: 4
   * (sixteenths, the default) or 3 (triplet eighths, a 12/8 feel, where a
   * sixteenth falls between the notes).
   */
  subdivision?: 3 | 4;
}

export type FilmMusic =
  | { kind: "dep" }
  | { kind: "file"; path: string; sectionStart: number; beat?: BeatGrid };

export const FILM_MUSIC: FilmMusic = {
  kind: "file",
  path: join(
    HOME_DIR,
    "Downloads/showcase/music-candidates/11-cant-stop-my-feet-loyalty-freak-music.mp3",
  ),
  sectionStart: 0,
  // Measured 2026-11-09 on this file: 130.00 BPM, first beat (a downbeat:
  // beats 0 and 2 of each bar carry the kick, every bar's fourth beat its
  // sixteenth-note pickup) 0.449 s — the grid's beats hold 14× the mean onset
  // over the whole track, every 20 s window ≥ 8.8×, ±0.01 BPM off it already
  // halves that. The 172.2 BPM measured on 2026-11-05 was an artefact of
  // reading the autocorrelation at whole lags of its 11.6 ms hop: 172.27 BPM
  // is exactly 30 hops, nearest the track's 4/3-beat accent spacing (173.3
  // BPM, 29.8 hops); on its grid the beats hold 1.3× the mean (none), and
  // v18's montage cuts, on it, met no onset.
  beat: { bpm: 130, firstBeat: 0.449 },
};

/**
 * Other tracks to audition the SAME recordings with, by slug — `film.ts
 * --music <slug>` renders `equin-v<N>-music-<slug>.mp4` with one of them,
 * FILM_MUSIC untouched. Each file is
 * `~/Downloads/showcase/music-candidates/<slug>/<slug>.mp3` (Loyalty Freak
 * Music, CC0). The beat grids were measured 2026-11-09 on these files the way
 * BeatGrid says (an onset envelope — log-energy rise per 11.6 ms — whose
 * autocorrelation at 16 multiples of the period picks the tempo in 95-200
 * BPM, then the phase whose beats sum the most onset). `sectionStart` is a
 * whole number of bars after `firstBeat`'s bar (film.ts aligns the montage
 * to the grid as if the section started on a bar), chosen so the film's
 * ~121 s end on the track's own ending — the start then falls in its full
 * groove, never on an intro.
 */
export const FILM_MUSIC_TRACKS = {
  "high-technologic-beat-explosion": candidate(
    "high-technologic-beat-explosion",
    { bpm: 139.98, firstBeat: 0.4071 },
    98.2,
  ),
  "hug-convoy": candidate(
    "hug-convoy",
    { bpm: 159.82, firstBeat: 0.2939 },
    76.3,
  ),
  "dance-robot-activate": candidate(
    "dance-robot-activate",
    { bpm: 120, firstBeat: 0.4912 },
    32,
  ),
  "im-on-fire": candidate("im-on-fire", { bpm: 143, firstBeat: 0.3962 }, 61.5),
  "go-to-the-picnic": candidate(
    "go-to-the-picnic",
    { bpm: 139.98, firstBeat: 0.4078 },
    64.8,
  ),
  "everyone-is-so-alive": candidate(
    "everyone-is-so-alive",
    { bpm: 159.96, firstBeat: 0.3265 },
    130.8,
  ),
  // Max Richter, "Spring 3" (Recomposed: Vivaldi, The Four Seasons; Daniel
  // Hope, Konzerthaus Kammerorchester Berlin) — ℗ 2012 Universal Music, NOT
  // licensed for publication: a private audition only. A live string
  // orchestra, so its tempo drifts (108 → 112 BPM across the piece; the
  // middle slips a beat against any one grid) and its beat divides in
  // triplets. Measured 2026-11-10 with a spectral-flux onset envelope (an
  // energy rise misses bowed notes): 111.415 BPM fitted jointly on the two
  // stretches the film snaps to — the title (66-69 s, an even triplet
  // stream: its beats hold 4.4-4.8× the mean onset per 2.5 s window) and
  // the montage to the end card (167-182 s: 3.9-7.5×, the local best phase
  // within 14 ms); its third and second-to-last thirds carry the triplets
  // (~2× the mean, a sixteenth's position none). firstBeat is the grid's
  // origin moved onto the beat its 4-beat accents peak on. The section
  // ends on the piece's last chord (182.73 s) ~2 s into the end card,
  // rung out (−48 dB at 184.1 s) as the closing fade starts.
  "richter-spring-3": candidate(
    "richter-spring-3",
    { bpm: 111.415, firstBeat: 1.93, subdivision: 3 },
    64.6,
  ),
} as const satisfies Record<string, FilmMusic>;

export type FilmMusicSlug = keyof typeof FILM_MUSIC_TRACKS;

/**
 * A candidate's entry. `approxStart` (s into the file) is rounded to the
 * nearest whole bar, so the section starts on the grid film.ts aligns to.
 */
function candidate(
  slug: string,
  beat: BeatGrid,
  approxStart: number,
): Extract<FilmMusic, { kind: "file" }> {
  const bar = (4 * 60) / beat.bpm;
  return {
    kind: "file",
    path: join(
      HOME_DIR,
      "Downloads/showcase/music-candidates",
      slug,
      `${slug}.mp3`,
    ),
    sectionStart: Math.round(approxStart / bar) * bar,
    beat,
  };
}

/** The candidate `--music` names, or a usage error naming them. */
export function filmMusicBySlug(slug: string): FilmMusic {
  if (!(slug in FILM_MUSIC_TRACKS))
    throw new Error(
      `promo-film: no music candidate "${slug}" — one of ${Object.keys(FILM_MUSIC_TRACKS).join(", ")}`,
    );
  return FILM_MUSIC_TRACKS[slug as FilmMusicSlug];
}

/** The beat grid of a film music, when it has one. */
export function filmMusicBeat(music: FilmMusic): BeatGrid | null {
  return music.kind === "file" ? (music.beat ?? null) : null;
}

/** The music file and where film t=0 starts in it. */
export async function resolveFilmMusic(music: FilmMusic): Promise<{
  file: string;
  sectionStart: number;
}> {
  if (music.kind === "file")
    return { file: music.path, sectionStart: music.sectionStart };
  const ready = await ensureDepViaCli(promoMusic, {
    stdio: "inherit",
    grant: null,
  });
  return {
    file: downloadedFile(ready, PROMO_MUSIC.file),
    sectionStart: PROMO_MUSIC.sectionStart,
  };
}
