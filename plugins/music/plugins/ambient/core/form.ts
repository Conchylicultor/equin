import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";

/**
 * The song form: what turns a mood's few progressions into music that never
 * plays the same minutes twice. A mood declares a palette — progressions per
 * section kind, the bars a section lasts, the keys it may move to — and the
 * composer writes an endless form from it, section by section: intro, verses,
 * choruses, a bridge, a breakdown, chosen by a Markov walk; the key moves now
 * and then; each section has its own melodic motif, stated then answered and
 * varied. Everything is deterministic from the seed, so a form can be tested.
 */

export const SECTION_KINDS = [
  "intro",
  "verse",
  "chorus",
  "bridge",
  "break",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** How a section is arranged: which layers play and how busy they are. */
export interface Arrangement {
  /** The drums (or the mood's rhythm layer) play. */
  readonly drums: boolean;
  /** The melody plays its motif. */
  readonly melody: boolean;
  /** 0..1: how many notes the decorations (comping, sparkles, birds) play. */
  readonly energy: number;
}

/** A melodic motif: notes as scale steps, at fractions of a bar. */
export interface Motif {
  readonly notes: readonly {
    /** Where in the bar, 0..1. */
    readonly at: number;
    /** Index into the mood's scale. */
    readonly step: number;
    /** Length, as a fraction of a bar. */
    readonly len: number;
  }[];
}

export interface FormSpec<C> {
  /** The progressions a section of each kind may play (one picked per section). */
  readonly progressions: Readonly<
    Record<SectionKind, readonly (readonly C[])[]>
  >;
  /** The bars a section of each kind lasts: a multiple of its progression is chosen in [min, max]. */
  readonly bars: Readonly<Record<SectionKind, readonly [number, number]>>;
  /** The key shifts (semitones from the written key) the song may move to; 0 must be among them. */
  readonly keys: readonly number[];
  /** How many steps the mood's melody scale has (a motif's steps stay inside it). */
  readonly scaleSteps: number;
}

/** What one bar plays: its chord, and where it sits in the form. */
export interface BarPlan<C> {
  readonly chord: C;
  /** The chord of the bar after this one (for a walk-up into it). */
  readonly nextChord: C;
  readonly kind: SectionKind;
  /** The section's index in the form. */
  readonly section: number;
  /** This bar's index within its section. */
  readonly barInSection: number;
  readonly sectionBars: number;
  /** Semitones to add to every written note: the song's current key. */
  readonly shift: number;
  readonly arrangement: Arrangement;
  /** The first bar of a section (an accent, an entry). */
  readonly entry: boolean;
  /** The last bar of a section (a fill, a turnaround). */
  readonly fill: boolean;
  /** The motif this bar plays: the section's theme, its answer, or a variation. */
  readonly motif: Motif;
  /** A random stream for this bar only, seeded from the form's seed and the bar. */
  readonly rand: () => number;
}

const ARRANGEMENTS: Readonly<Record<SectionKind, Arrangement>> = {
  intro: { drums: false, melody: false, energy: 0.3 },
  verse: { drums: true, melody: true, energy: 0.55 },
  chorus: { drums: true, melody: true, energy: 0.9 },
  bridge: { drums: true, melody: true, energy: 0.6 },
  break: { drums: false, melody: true, energy: 0.25 },
};

/** Which section may follow which, with weights. */
const NEXT: Readonly<Record<SectionKind, readonly [SectionKind, number][]>> = {
  intro: [["verse", 1]],
  verse: [
    ["verse", 0.25],
    ["chorus", 0.55],
    ["bridge", 0.2],
  ],
  chorus: [
    ["verse", 0.45],
    ["bridge", 0.25],
    ["break", 0.3],
  ],
  bridge: [
    ["chorus", 0.7],
    ["break", 0.3],
  ],
  break: [
    ["chorus", 0.5],
    ["verse", 0.5],
  ],
};

/** After this many sections the key may move (on a section that starts afresh). */
const SECTIONS_PER_KEY = 5;

interface Section<C> {
  readonly index: number;
  readonly kind: SectionKind;
  readonly start: number;
  readonly bars: number;
  readonly progression: readonly C[];
  readonly shift: number;
  readonly arrangement: Arrangement;
  readonly theme: Motif;
  readonly answer: Motif;
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(rand() * xs.length)];
  if (x === undefined) throw new Error("ambient form: pick from an empty list");
  return x;
}

function weighted<T>(rand: () => number, xs: readonly [T, number][]): T {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let u = rand() * total;
  for (const [x, w] of xs) {
    u -= w;
    if (u < 0) return x;
  }
  const last = xs.at(-1);
  if (!last) throw new Error("ambient form: weighted pick from an empty list");
  return last[0];
}

const clampStep = (s: number, steps: number) =>
  Math.max(0, Math.min(steps - 1, s));

/** A new motif: a few notes on a rhythm grid of eighths, a stepwise contour. */
export function makeMotif(
  rand: () => number,
  steps: number,
  density: number,
): Motif {
  const grid = 8;
  const notes: { at: number; step: number; len: number }[] = [];
  let step = Math.floor(steps / 2 + (rand() - 0.5) * (steps / 2));
  for (let g = 0; g < grid; g++) {
    // the downbeat is likelier than the offbeats, so the line has a pulse
    const p = density * (g % 2 === 0 ? 1 : 0.55);
    if (rand() >= p) continue;
    notes.push({ at: g / grid, step: clampStep(step, steps), len: 1.5 / grid });
    const leap = rand() < 0.2 ? 2 : 1;
    step += (rand() < 0.5 ? -1 : 1) * leap;
    if (step <= 0 || step >= steps - 1)
      step = clampStep(step, steps) + (step <= 0 ? 1 : -1);
  }
  if (notes.length === 0)
    notes.push({ at: 0, step: clampStep(step, steps), len: 2 / grid });
  // each note holds until the next one (or its own length, if shorter)
  return {
    notes: notes.map((n, k) => {
      const next = notes[k + 1]?.at ?? 1;
      return { ...n, len: Math.min(next - n.at + 0.06, n.len * 2) };
    }),
  };
}

/** The motif's answer: same rhythm, the contour mirrored, ending elsewhere. */
export function answerOf(m: Motif, steps: number, rand: () => number): Motif {
  const first = m.notes[0]?.step ?? 0;
  const lift = rand() < 0.5 ? 1 : -1;
  return {
    notes: m.notes.map((n, k) => ({
      ...n,
      step: clampStep(
        first - (n.step - first) + (k === m.notes.length - 1 ? lift : 0),
        steps,
      ),
    })),
  };
}

/** A light variation: one note moved by a step, now and then one dropped. */
export function varyMotif(m: Motif, steps: number, rand: () => number): Motif {
  const k = Math.floor(rand() * m.notes.length);
  const drop = m.notes.length > 2 && rand() < 0.3;
  return {
    notes: m.notes.flatMap((n, j) => {
      if (j !== k) return [n];
      if (drop) return [];
      return [
        { ...n, step: clampStep(n.step + (rand() < 0.5 ? -1 : 1), steps) },
      ];
    }),
  };
}

export interface Composer<C> {
  /**
   * The plan of bar `i`. Bars are asked in order, from 0 (a bar may be skipped
   * — a slept tab); only the current section is kept, so the form is bounded
   * however long it plays, and asking a bar of a section already passed throws.
   */
  barAt(i: number): BarPlan<C>;
}

/** An endless form from a mood's palette, deterministic from `seed`. */
export function createComposer<C>(
  spec: FormSpec<C>,
  seed: number,
): Composer<C> {
  if (!spec.keys.includes(0))
    throw new Error("ambient form: the written key (0) must be among the keys");
  for (const k of SECTION_KINDS)
    if (
      spec.progressions[k].some((p) => p.length === 0) ||
      spec.progressions[k].length === 0
    )
      throw new Error(
        `ambient form: section "${k}" has no progression to play`,
      );
  const rand = mulberry32(seed);
  // the sections from the current one on (a bar's next chord may reach one ahead)
  const sections: Section<C>[] = [];
  let made = 0;
  let shift = 0;

  const sectionFor = (
    kind: SectionKind,
    start: number,
    index: number,
  ): Section<C> => {
    const progression = pick(rand, spec.progressions[kind]);
    const [min, max] = spec.bars[kind];
    const len = progression.length;
    const lo = Math.max(1, Math.ceil(min / len));
    const hi = Math.max(lo, Math.floor(max / len));
    const bars = len * (lo + Math.floor(rand() * (hi - lo + 1)));
    // the key moves on a fresh start, once enough sections have passed
    if (
      index > 0 &&
      index % SECTIONS_PER_KEY === 0 &&
      (kind === "verse" || kind === "chorus" || kind === "break")
    )
      shift = pick(
        rand,
        spec.keys.filter((k) => k !== shift),
      );
    const base = ARRANGEMENTS[kind];
    // a bridge sometimes drops the drums; a verse sometimes leaves the melody out
    const arrangement: Arrangement = {
      drums: kind === "bridge" ? rand() < 0.6 : base.drums,
      melody: kind === "verse" ? rand() < 0.8 : base.melody,
      energy: Math.max(0, Math.min(1, base.energy + (rand() - 0.5) * 0.2)),
    };
    const density = kind === "chorus" ? 0.7 : kind === "break" ? 0.35 : 0.5;
    const theme = makeMotif(rand, spec.scaleSteps, density);
    const answer = answerOf(theme, spec.scaleSteps, rand);
    return {
      index,
      kind,
      start,
      bars,
      progression,
      shift,
      arrangement,
      theme,
      answer,
    };
  };

  const extendTo = (i: number) => {
    while ((sections.at(-1)?.start ?? 0) + (sections.at(-1)?.bars ?? 0) <= i) {
      const prev = sections.at(-1);
      const kind: SectionKind = prev
        ? weighted(rand, NEXT[prev.kind])
        : "intro";
      sections.push(
        sectionFor(kind, prev ? prev.start + prev.bars : 0, made++),
      );
    }
  };

  const sectionAt = (i: number): Section<C> => {
    extendTo(i);
    const s = sections.find((x) => x.start <= i && i < x.start + x.bars);
    if (!s)
      throw new Error(`ambient form: bar ${i} is in a section already passed`);
    return s;
  };

  return {
    barAt(i) {
      if (!(i >= 0) || !Number.isInteger(i))
        throw new Error(`ambient form: bar ${i} is not a bar index`);
      const s = sectionAt(i);
      // forget the sections before this one: bars only move forward
      while (sections[0] && sections[0] !== s) sections.shift();
      const inSection = i - s.start;
      const len = s.progression.length;
      const chord = s.progression[inSection % len]!;
      const nextChord =
        inSection + 1 < s.bars
          ? s.progression[(inSection + 1) % len]!
          : sectionAt(i + 1).progression[0]!;
      const barRand = mulberry32((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
      // statement, answer, statement, varied answer…
      const motif =
        inSection % 2 === 0
          ? inSection % 4 === 0
            ? s.theme
            : varyMotif(s.theme, spec.scaleSteps, barRand)
          : inSection % 4 === 1
            ? s.answer
            : varyMotif(s.answer, spec.scaleSteps, barRand);
      return {
        chord,
        nextChord,
        kind: s.kind,
        section: s.index,
        barInSection: inSection,
        sectionBars: s.bars,
        shift: s.shift,
        arrangement: s.arrangement,
        entry: inSection === 0,
        fill: inSection === s.bars - 1,
        motif,
        rand: barRand,
      };
    },
  };
}
