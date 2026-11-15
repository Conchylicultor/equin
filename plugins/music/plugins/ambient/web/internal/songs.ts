// The songs, each a bar generator: write bar `i` starting at audio time
// `t` into the rig, answer how long the bar is.

import type { AmbientMood } from "../../core";
import {
  bass,
  bell,
  chirp,
  cricket,
  hat,
  keys,
  kick,
  midi,
  pad,
  pluck,
  rim,
  shaker,
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

const BOSSA_BEAT = 60 / 84;
/** bossa: 84 bpm, Dm9 – G13 – Cmaj9 – A7♭13, a nylon guitar over a shaker and rim clave. */
const BOSSA = [
  { root: 38, fifth: 45, chord: [53, 57, 60, 64] },
  { root: 43, fifth: 38, chord: [53, 59, 64] },
  { root: 36, fifth: 43, chord: [52, 55, 59, 62] },
  { root: 45, fifth: 40, chord: [55, 61, 65] },
] as const;
/** The guitar's syncopated stabs, in eighths, for the clave's two bars. */
const BOSSA_STABS = [
  [0, 3, 6],
  [2, 4, 7],
] as const;
const BOSSA_CLAVE = [
  [0, 3, 6],
  [2, 4],
] as const;
const C_PENTA = [72, 74, 76, 79, 81, 84] as const;

function bossaBar(r: Rig, t: number, i: number): void {
  const beat = BOSSA_BEAT;
  const e = beat / 2;
  const c = BOSSA[i % 4]!;
  // the guitar's thumb: root on 1, fifth on 3 (and its pickup)
  pluck(r, midi(c.root), t, 0.09, beat * 1.8);
  pluck(r, midi(c.fifth), t + beat * 2, 0.08, beat * 1.6);
  pluck(r, midi(c.root), t + beat * 3.5, 0.05, beat * 0.9);
  bass(r, midi(c.root - 12), t, beat * 1.6, 0.07);
  for (const s of BOSSA_STABS[i % 2]!)
    c.chord.forEach((n, k) =>
      pluck(r, midi(n), t + s * e + k * 0.012, 0.035, e * 1.6),
    );
  // a soft keys bed under the guitar
  if (i % 2 === 0)
    for (const n of c.chord) keys(r, midi(n), t, beat * 7.5, 0.012);
  if (i >= 2) {
    for (let h = 0; h < 16; h++)
      shaker(
        r,
        t + (h * beat) / 4,
        h % 4 === 0 ? 0.014 : h % 2 ? 0.006 : 0.009,
      );
    for (const s of BOSSA_CLAVE[i % 2]!) rim(r, t + s * e, 0.035);
  }
  if (i % 4 === 0) waves(r, t + 0.5, 10);
  if (i >= 4 && Math.random() < 0.7) {
    // a hummed line over the changes, a few notes of the pentatonic
    let k0 = Math.floor(Math.random() * C_PENTA.length);
    for (let k = 0; k < 6; k++)
      if (Math.random() < 0.45) {
        keys(r, midi(C_PENTA[k0]!), t + e + k * e * 1.2, beat * 1.4, 0.03);
        k0 = Math.max(
          0,
          Math.min(C_PENTA.length - 1, k0 + (Math.random() < 0.5 ? -1 : 1)),
        );
      }
  }
}

const NOC_BEAT = 60 / 54;
/** nocturne: 3/4 at 54 bpm, Am(add9) – Fmaj7 – C/G – Em7, rolled piano, crickets and fireflies. */
const NOC = [
  { root: 45, arp: [57, 64, 71, 72, 76] },
  { root: 41, arp: [53, 60, 64, 69, 72] },
  { root: 43, arp: [55, 60, 64, 67, 71] },
  { root: 40, arp: [52, 59, 62, 67, 71] },
] as const;
/** Which arpeggio note each eighth plays: up, then back down. */
const NOC_ROLL = [0, 1, 2, 3, 2, 1] as const;
const NOC_SPARKS = [81, 83, 84, 88, 91] as const;

function nocturneBar(r: Rig, t: number, i: number): void {
  const beat = NOC_BEAT;
  const e = beat / 2;
  const c = NOC[i % 4]!;
  bass(r, midi(c.root - 12), t, beat * 3, 0.07);
  pad(r, midi(c.arp[0]), t, beat * 3 + 1.5, 0.008);
  pad(r, midi(c.arp[2]), t, beat * 3 + 1.5, 0.006);
  NOC_ROLL.forEach((k, s) => {
    const top = s === 3 && i % 2 === 1 ? 4 : k;
    keys(r, midi(c.arp[top]!), t + s * e, beat * 2.2, s === 0 ? 0.04 : 0.028);
  });
  // fireflies: a high music-box note now and then
  if (i >= 2)
    for (let k = 0; k < 2; k++)
      if (Math.random() < 0.45)
        bell(
          r,
          midi(NOC_SPARKS[Math.floor(Math.random() * NOC_SPARKS.length)]!),
          t + Math.random() * beat * 3,
          0.018,
        );
  for (let k = 0; k < 4; k++)
    if (Math.random() < 0.6) cricket(r, t + Math.random() * beat * 3);
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
  bossa: { barSec: BOSSA_BEAT * 4, bar: bossaBar, crackle: false },
  nocturne: { barSec: NOC_BEAT * 3, bar: nocturneBar, crackle: true },
};
