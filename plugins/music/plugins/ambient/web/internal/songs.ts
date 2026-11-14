// The two songs, each a bar generator: write bar `i` starting at audio time
// `t` into the rig, answer how long the bar is.

import type { AmbientMood } from "../../core";
import {
  bass,
  bell,
  chirp,
  hat,
  keys,
  kick,
  midi,
  pad,
  snare,
  waves,
  type Rig,
} from "./voices";

const LOFI_BEAT = 60 / 72;

/** lofi: 72 bpm, Fmaj9 – Em7 – Dm9 – Cmaj7(+G) with swing. */
const LOFI = [
  { root: 41, chord: [53, 57, 60, 64, 67] },
  { root: 40, chord: [52, 55, 59, 62, 65] },
  { root: 38, chord: [53, 57, 60, 62, 64] },
  { root: 36, chord: [52, 55, 59, 60, 64] },
] as const;
const PENTA = [60, 62, 64, 67, 69, 72, 74, 76] as const;

function lofiBar(r: Rig, t: number, i: number): void {
  const beat = LOFI_BEAT;
  const sw = beat * 0.16;
  const c = LOFI[i % 4]!;
  c.chord.forEach((n, k) => keys(r, midi(n), t + k * 0.018, beat * 3.6, 0.055));
  if (i % 2 === 1)
    for (const n of c.chord.slice(1, 4))
      keys(r, midi(n), t + beat * 2.5 + sw, beat * 1.4, 0.035);
  bass(r, midi(c.root), t, beat * 1.8);
  bass(r, midi(c.root + 7), t + beat * 2.5 + sw, beat * 1.2, 0.1);
  if (i >= 2) {
    kick(r, t);
    kick(r, t + beat * 2.5 + sw);
    snare(r, t + beat);
    snare(r, t + beat * 3);
    for (let h = 0; h < 8; h++)
      hat(r, t + (h * beat) / 2 + (h % 2 ? sw : 0), h % 2 ? 0.014 : 0.024);
  }
  if (i >= 4 && Math.random() < 0.8) {
    // little melodic phrases, wandering the pentatonic scale
    let k0 = Math.floor(Math.random() * 5) + 2;
    for (let k = 0; k < 4; k++)
      if (Math.random() < 0.6) {
        keys(
          r,
          midi(PENTA[k0]! + 12),
          t + k * beat + (k % 2 ? sw : 0) + beat * 0.5,
          beat * 1.2,
          0.04,
        );
        k0 = Math.max(
          0,
          Math.min(PENTA.length - 1, k0 + (Math.random() < 0.5 ? -1 : 1)),
        );
      }
  }
}

const AMB_BAR = 8;
/** ambient: slow pads in D lydian-ish, bells, surf, birds. */
const AMB = [
  [50, 57, 62, 66, 69],
  [47, 54, 59, 62, 66],
  [43, 50, 57, 62, 64],
  [45, 52, 57, 61, 64],
] as const;
const AMB_BELLS = [74, 76, 78, 81, 83, 86] as const;

function ambientBar(r: Rig, t: number, i: number): void {
  const len = AMB_BAR;
  const chord = AMB[i % 4]!;
  for (const n of chord) pad(r, midi(n), t, len + 1.5, 0.018);
  bass(r, midi(chord[0] - 12), t, len, 0.08);
  for (let k = 0; k < 5; k++)
    if (Math.random() < 0.55)
      bell(
        r,
        midi(AMB_BELLS[Math.floor(Math.random() * AMB_BELLS.length)]!),
        t + Math.random() * len,
        0.035,
      );
  if (i % 2 === 0) waves(r, t + 1, 9);
  for (let k = 0; k < 3; k++)
    if (Math.random() < 0.4) {
      const ct = t + Math.random() * len;
      chirp(r, ct);
      chirp(r, ct + 0.16);
    }
}

export interface Song {
  readonly barSec: number;
  bar(r: Rig, t: number, i: number): void;
  /** Vinyl crackle under it. */
  readonly crackle: boolean;
}

export const SONGS: Readonly<Record<AmbientMood, Song>> = {
  lofi: { barSec: LOFI_BEAT * 4, bar: lofiBar, crackle: true },
  ambient: { barSec: AMB_BAR, bar: ambientBar, crackle: false },
};
