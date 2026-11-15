// The songs. Each declares a palette — progressions per section kind, the
// bars a section lasts, the keys it may move to, its melody scale — and a bar
// writer that plays one bar of the form the composer writes from it
// (`core/form`): which chord, which section, which layers, which motif. So a
// song is an endless arrangement, never the same four bars over and over.

import {
  createComposer,
  type AmbientMood,
  type BarPlan,
  type FormSpec,
  type Motif,
} from "../../core";
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

/** One bar's writer: write bar `i` starting at audio time `t`. */
export type BarWriter = (r: Rig, t: number, i: number) => void;

export interface Song {
  readonly barSec: number;
  /** A fresh, endless form of the song, deterministic from `seed`. */
  compose(seed: number): BarWriter;
  /** Vinyl crackle under it. */
  readonly crackle: boolean;
}

function defineSong<C>(def: {
  readonly barSec: number;
  readonly crackle: boolean;
  readonly form: FormSpec<C>;
  readonly bar: (r: Rig, t: number, p: BarPlan<C>) => void;
}): Song {
  return {
    barSec: def.barSec,
    crackle: def.crackle,
    compose(seed) {
      const composer = createComposer(def.form, seed);
      return (r, t, i) => def.bar(r, t, composer.barAt(i));
    },
  };
}

/** Plays a motif over a bar: each note at its place, through `note`. */
function playMotif(
  m: Motif,
  scale: readonly number[],
  barSec: number,
  note: (n: number, at: number, len: number, k: number) => void,
): void {
  m.notes.forEach((x, k) => {
    const n = scale[x.step];
    if (n === undefined)
      throw new Error(`ambient: motif step ${x.step} is outside its scale`);
    note(n, x.at * barSec, x.len * barSec, k);
  });
}

/* ------------------------------------------------------------------ lofi */

const LOFI_BEAT = 60 / 72;
const LOFI_BAR = LOFI_BEAT * 4;

interface LofiChord {
  readonly root: number;
  readonly chord: readonly number[];
}
const L = {
  Fmaj9: { root: 41, chord: [53, 57, 60, 64, 67] },
  Em7: { root: 40, chord: [52, 55, 59, 62, 65] },
  Dm9: { root: 38, chord: [53, 57, 60, 62, 64] },
  Cmaj7: { root: 36, chord: [52, 55, 59, 60, 64] },
  G13: { root: 43, chord: [53, 57, 59, 64] },
  Cmaj9: { root: 36, chord: [52, 55, 59, 62] },
  Am7: { root: 45, chord: [55, 57, 60, 64] },
  Bbmaj7: { root: 34, chord: [53, 57, 58, 62] },
  Gm9: { root: 43, chord: [53, 57, 58, 62] },
  C9: { root: 36, chord: [52, 55, 58, 62] },
  Bbm6: { root: 34, chord: [53, 55, 58, 61] },
  A7: { root: 45, chord: [55, 61, 65] },
  C7sus: { root: 36, chord: [53, 55, 58, 62] },
} satisfies Record<string, LofiChord>;
const PENTA = [60, 62, 64, 67, 69, 72, 74, 76] as const;

function lofiBar(r: Rig, t: number, p: BarPlan<LofiChord>): void {
  const beat = LOFI_BEAT;
  const sw = beat * 0.16;
  const { chord: c, arrangement: a, rand } = p;
  const m = (n: number) => midi(n + p.shift);
  c.chord.forEach((n, k) =>
    keys(r, m(n), t + k * 0.018, beat * 3.6, 0.045 + a.energy * 0.015),
  );
  if (p.barInSection % 2 === 1 || (a.energy > 0.7 && rand() < 0.5))
    for (const n of c.chord.slice(1, 4))
      keys(r, m(n), t + beat * 2.5 + sw, beat * 1.4, 0.035);
  bass(r, m(c.root), t, beat * 1.8);
  if (p.fill && a.drums) {
    // walk up into the next chord
    bass(r, m(c.root + 7), t + beat * 2, beat * 0.9, 0.09);
    bass(r, m(p.nextChord.root - 1), t + beat * 3 + sw, beat * 0.8, 0.09);
  } else bass(r, m(c.root + 7), t + beat * 2.5 + sw, beat * 1.2, 0.1);
  if (a.drums) {
    kick(r, t);
    kick(r, t + beat * 2.5 + sw);
    if (a.energy > 0.7 && rand() < 0.5) kick(r, t + beat * 1.5 + sw);
    snare(r, t + beat);
    snare(r, t + beat * 3);
    const hats = p.fill ? 6 : 8;
    for (let h = 0; h < hats; h++)
      hat(r, t + (h * beat) / 2 + (h % 2 ? sw : 0), h % 2 ? 0.014 : 0.024);
    if (p.fill)
      // a little snare roll into the next section
      for (let k = 0; k < 3; k++) snare(r, t + beat * 3.25 + (k * beat) / 4);
  } else if (p.kind === "break")
    for (let h = 0; h < 4; h++) hat(r, t + h * beat + sw, 0.01);
  if (a.melody)
    playMotif(p.motif, PENTA, LOFI_BAR, (n, at, len, k) => {
      const swing = Math.round(at / (beat / 2)) % 2 ? sw : 0;
      keys(r, m(n + 12), t + at + swing, Math.max(len, beat * 0.8), 0.04);
      if (p.kind === "chorus" && k % 2 === 0)
        keys(r, m(n), t + at + swing, Math.max(len, beat * 0.8), 0.018);
    });
}

const LOFI = defineSong<LofiChord>({
  barSec: LOFI_BAR,
  crackle: true,
  form: {
    progressions: {
      intro: [
        [L.Fmaj9, L.Em7],
        [L.Dm9, L.Cmaj7],
      ],
      verse: [
        [L.Fmaj9, L.Em7, L.Dm9, L.Cmaj7],
        [L.Dm9, L.G13, L.Cmaj9, L.Am7],
      ],
      chorus: [
        [L.Bbmaj7, L.Am7, L.Gm9, L.C9],
        [L.Fmaj9, L.Am7, L.Bbmaj7, L.C7sus],
      ],
      bridge: [
        [L.Gm9, L.C9, L.Am7, L.Dm9],
        [L.Bbmaj7, L.Bbm6, L.Am7, L.A7],
      ],
      break: [
        [L.Bbmaj7, L.Fmaj9],
        [L.Dm9, L.Bbmaj7],
      ],
    },
    bars: {
      intro: [2, 4],
      verse: [8, 16],
      chorus: [8, 8],
      bridge: [4, 8],
      break: [4, 4],
    },
    keys: [0, 2, -2, -4, 3],
    scaleSteps: PENTA.length,
  },
  bar: lofiBar,
});

/* --------------------------------------------------------------- ambient */

const AMB_BAR = 8;
/** D lydian-ish pads: the bass note first. */
type AmbChord = readonly number[];
const A = {
  D: [50, 57, 62, 66, 69],
  Bm: [47, 54, 59, 62, 66],
  Gadd9: [43, 50, 57, 62, 64],
  A: [45, 52, 57, 61, 64],
  Gmaj7s11: [43, 54, 59, 61, 66],
  Em9: [40, 50, 55, 59, 66],
  Fsm: [42, 49, 54, 57, 61],
  Em: [40, 47, 55, 59, 66],
} satisfies Record<string, AmbChord>;
const AMB_BELLS = [74, 76, 78, 81, 83, 86] as const;

function ambientBar(r: Rig, t: number, p: BarPlan<AmbChord>): void {
  const len = AMB_BAR;
  const { chord, arrangement: a, rand } = p;
  const m = (n: number) => midi(n + p.shift);
  for (const n of chord) pad(r, m(n), t, len + 1.5, 0.018);
  bass(r, m(chord[0]! - 12), t, len, a.drums ? 0.08 : 0.05);
  if (a.melody)
    // the bells carry the section's motif, slow and wide apart
    playMotif(p.motif, AMB_BELLS, len, (n, at) => bell(r, m(n), t + at, 0.03));
  for (let k = 0; k < 3; k++)
    if (rand() < 0.25 + a.energy * 0.3)
      bell(
        r,
        m(AMB_BELLS[Math.floor(rand() * AMB_BELLS.length)]!),
        t + rand() * len,
        0.02,
      );
  if (p.barInSection % 2 === 0 || p.entry) waves(r, t + 1, 9);
  for (let k = 0; k < 3; k++)
    if (rand() < 0.2 + a.energy * 0.3) {
      const ct = t + rand() * len;
      chirp(r, ct);
      chirp(r, ct + 0.16);
    }
}

const AMBIENT = defineSong<AmbChord>({
  barSec: AMB_BAR,
  crackle: false,
  form: {
    progressions: {
      intro: [[A.D, A.Gadd9]],
      verse: [
        [A.D, A.Bm, A.Gadd9, A.A],
        [A.Gadd9, A.D, A.Em, A.A],
      ],
      chorus: [
        [A.Gmaj7s11, A.D, A.Em9, A.A],
        [A.Bm, A.Gmaj7s11, A.D, A.A],
      ],
      bridge: [[A.Bm, A.Gadd9, A.Em, A.Fsm]],
      break: [[A.D], [A.Gmaj7s11]],
    },
    bars: {
      intro: [2, 2],
      verse: [4, 8],
      chorus: [4, 8],
      bridge: [4, 4],
      break: [2, 3],
    },
    keys: [0, -2, 2, -3],
    scaleSteps: AMB_BELLS.length,
  },
  bar: ambientBar,
});

/* ----------------------------------------------------------------- bossa */

const BOSSA_BEAT = 60 / 84;
const BOSSA_BAR = BOSSA_BEAT * 4;
interface BossaChord {
  readonly root: number;
  readonly fifth: number;
  readonly chord: readonly number[];
}
const B = {
  Dm9: { root: 38, fifth: 45, chord: [53, 57, 60, 64] },
  G13: { root: 43, fifth: 38, chord: [53, 59, 64] },
  Cmaj9: { root: 36, fifth: 43, chord: [52, 55, 59, 62] },
  A7b13: { root: 45, fifth: 40, chord: [55, 61, 65] },
  Am9: { root: 45, fifth: 40, chord: [55, 59, 60, 64] },
  Fmaj7: { root: 41, fifth: 36, chord: [52, 57, 60, 64] },
  Fm6: { root: 41, fifth: 36, chord: [50, 53, 56, 60] },
  Em7: { root: 40, fifth: 47, chord: [50, 55, 59, 62] },
  Ebmaj7: { root: 39, fifth: 46, chord: [51, 55, 58, 62] },
  Dbmaj7: { root: 37, fifth: 44, chord: [48, 53, 56, 60] },
  Bbmaj7: { root: 46, fifth: 41, chord: [50, 53, 57, 62] },
} satisfies Record<string, BossaChord>;
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

function bossaBar(r: Rig, t: number, p: BarPlan<BossaChord>): void {
  const beat = BOSSA_BEAT;
  const e = beat / 2;
  const { chord: c, arrangement: a, rand } = p;
  const m = (n: number) => midi(n + p.shift);
  const half = p.barInSection % 2;
  // the guitar's thumb: root on 1, fifth on 3 (and its pickup)
  pluck(r, m(c.root), t, 0.09, beat * 1.8);
  pluck(r, m(c.fifth), t + beat * 2, 0.08, beat * 1.6);
  pluck(
    r,
    m(p.fill ? p.nextChord.root : c.root),
    t + beat * 3.5,
    0.05,
    beat * 0.9,
  );
  bass(r, m(c.root - 12), t, beat * 1.6, 0.07);
  for (const s of BOSSA_STABS[half]!)
    c.chord.forEach((n, k) =>
      pluck(r, m(n), t + s * e + k * 0.012, 0.035, e * 1.6),
    );
  // a soft keys bed under the guitar
  if (half === 0 && a.energy > 0.4)
    for (const n of c.chord) keys(r, m(n), t, beat * 7.5, 0.012);
  if (a.drums) {
    for (let h = 0; h < 16; h++)
      shaker(
        r,
        t + (h * beat) / 4,
        h % 4 === 0 ? 0.014 : h % 2 ? 0.006 : 0.009,
      );
    for (const s of BOSSA_CLAVE[half]!) rim(r, t + s * e, 0.035);
    if (p.fill)
      for (let k = 0; k < 3; k++) rim(r, t + beat * 3 + (k * e) / 1.5, 0.025);
  } else if (p.kind === "break")
    for (let h = 0; h < 4; h++) shaker(r, t + h * beat, 0.007);
  if (p.entry && rand() < 0.6) waves(r, t + 0.5, 10);
  if (a.melody)
    // a hummed line over the changes
    playMotif(p.motif, C_PENTA, BOSSA_BAR, (n, at, len) =>
      keys(r, m(n), t + at, Math.max(len, beat), 0.03),
    );
}

const BOSSA = defineSong<BossaChord>({
  barSec: BOSSA_BAR,
  crackle: false,
  form: {
    progressions: {
      intro: [
        [B.Dm9, B.G13],
        [B.Cmaj9, B.Am9],
      ],
      verse: [
        [B.Dm9, B.G13, B.Cmaj9, B.A7b13],
        [B.Cmaj9, B.Am9, B.Dm9, B.G13],
      ],
      chorus: [
        [B.Fmaj7, B.Fm6, B.Em7, B.A7b13],
        [B.Dm9, B.G13, B.Em7, B.A7b13],
      ],
      bridge: [
        [B.Ebmaj7, B.Dm9, B.Dbmaj7, B.Cmaj9],
        [B.Bbmaj7, B.A7b13, B.Dm9, B.Dm9],
      ],
      break: [[B.Cmaj9, B.Fmaj7]],
    },
    bars: {
      intro: [2, 4],
      verse: [8, 16],
      chorus: [8, 8],
      bridge: [4, 8],
      break: [4, 4],
    },
    keys: [0, 2, -2, -3],
    scaleSteps: C_PENTA.length,
  },
  bar: bossaBar,
});

/* -------------------------------------------------------------- nocturne */

const NOC_BEAT = 60 / 54;
const NOC_BAR = NOC_BEAT * 3;
interface NocChord {
  readonly root: number;
  /** Five notes, low to high. */
  readonly arp: readonly [number, number, number, number, number];
}
const N = {
  Am: { root: 45, arp: [57, 64, 71, 72, 76] },
  Fmaj7: { root: 41, arp: [53, 60, 64, 69, 72] },
  CG: { root: 43, arp: [55, 60, 64, 67, 71] },
  Em7: { root: 40, arp: [52, 59, 62, 67, 71] },
  Dm7: { root: 38, arp: [50, 57, 60, 65, 69] },
  G: { root: 43, arp: [55, 59, 62, 67, 71] },
  Cmaj7: { root: 36, arp: [48, 55, 59, 64, 67] },
  E7: { root: 40, arp: [52, 56, 62, 64, 68] },
  Bm7b5: { root: 35, arp: [47, 53, 57, 62, 65] },
  F: { root: 41, arp: [53, 60, 65, 69, 72] },
} satisfies Record<string, NocChord>;
/** Which arpeggio note each eighth plays: up, then back down. */
const NOC_ROLL = [0, 1, 2, 3, 2, 1] as const;
/** The other rolls a section may take: up and over, a broken pattern. */
const NOC_ROLLS = [NOC_ROLL, [0, 2, 1, 3, 4, 2], [0, 1, 2, 4, 3, 1]] as const;
const A_PENTA = [69, 72, 74, 76, 79, 81, 84] as const;

function nocturneBar(r: Rig, t: number, p: BarPlan<NocChord>): void {
  const beat = NOC_BEAT;
  const e = beat / 2;
  const { chord: c, arrangement: a, rand } = p;
  const m = (n: number) => midi(n + p.shift);
  bass(r, m(c.root - 12), t, beat * 3, 0.07);
  pad(r, m(c.arp[0]), t, beat * 3 + 1.5, 0.008);
  pad(r, m(c.arp[2]), t, beat * 3 + 1.5, 0.006);
  // "drums" here are the rolling left hand; without them, a held chord
  if (a.drums) {
    const roll = NOC_ROLLS[p.section % NOC_ROLLS.length]!;
    roll.forEach((k, s) => {
      const top = s === 3 && p.barInSection % 2 === 1 ? 4 : k;
      keys(r, m(c.arp[top]), t + s * e, beat * 2.2, s === 0 ? 0.04 : 0.028);
    });
  } else
    c.arp
      .slice(0, 4)
      .forEach((n, k) => keys(r, m(n), t + k * 0.09, beat * 3, 0.03));
  if (a.melody)
    // the right hand's song, an octave over the roll
    playMotif(p.motif, A_PENTA, NOC_BAR, (n, at, len) =>
      keys(r, m(n), t + at, Math.max(len, beat * 1.2), 0.032),
    );
  // fireflies: a high music-box note now and then
  for (let k = 0; k < 2; k++)
    if (rand() < 0.15 + a.energy * 0.35)
      bell(
        r,
        m(A_PENTA[4 + Math.floor(rand() * 3)]! + 12),
        t + rand() * beat * 3,
        0.016,
      );
  for (let k = 0; k < 4; k++)
    if (rand() < 0.6) cricket(r, t + rand() * beat * 3);
}

const NOCTURNE = defineSong<NocChord>({
  barSec: NOC_BAR,
  crackle: true,
  form: {
    progressions: {
      intro: [[N.Am, N.Fmaj7]],
      verse: [
        [N.Am, N.Fmaj7, N.CG, N.Em7],
        [N.Am, N.Dm7, N.G, N.Cmaj7],
      ],
      chorus: [
        [N.F, N.G, N.Em7, N.Am],
        [N.Dm7, N.Em7, N.Fmaj7, N.E7],
      ],
      bridge: [
        [N.Dm7, N.G, N.Cmaj7, N.Fmaj7, N.Bm7b5, N.E7, N.Am, N.Am],
        [N.Fmaj7, N.Fmaj7, N.E7, N.E7],
      ],
      break: [[N.Am, N.Fmaj7]],
    },
    bars: {
      intro: [2, 4],
      verse: [8, 16],
      chorus: [8, 8],
      bridge: [4, 8],
      break: [4, 4],
    },
    keys: [0, 2, -2, 3],
    scaleSteps: A_PENTA.length,
  },
  bar: nocturneBar,
});

export const SONGS: Readonly<Record<AmbientMood, Song>> = {
  lofi: LOFI,
  ambient: AMBIENT,
  bossa: BOSSA,
  nocturne: NOCTURNE,
};
