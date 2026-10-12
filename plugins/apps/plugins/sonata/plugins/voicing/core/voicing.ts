/**
 * The voicing engine: timed chord events → performed notes.
 *
 * The "chord → notes" direction of Sonata's two-layer model. A chord-authoring
 * source authors chord *annotations* (root + quality, timed in quarter-note
 * beats) and this engine *derives* the literal `Note[]` a player can sound and
 * draw — the opposite of the MIDI source, which carries notes directly.
 *
 * This is a shared leaf: any source (chord-grid, Ultimate Guitar, …) feeds its
 * `ChordEvent[]` here, so chord voicing has exactly one home. The caller owns its
 * own track id and note-id namespace via `VoicingOptions`, so two sources never
 * collide on track or note id. Pitch math is delegated to `theory`'s
 * `chordPitches`; *which* tones sound at each onset is delegated to a per-hand
 * {@link Figuration} (the tone-order axis); this engine only places the tone-sets
 * and walks the rhythm necklace.
 *
 * Two paths:
 *  - **No-groove** (`opts.rhythm` absent) — one block note per placed tone per
 *    chord, held for the chord's duration, with a bass root iff `voiceLead`. A
 *    figuration only bites when a rhythm necklace exists, so this path is
 *    byte-for-byte the historical block-chord behaviour.
 *  - **Groove** (`opts.rhythm` present) — two tone-sets are placed per chord (a
 *    voice-led chord register and a low root-position bass register) and each
 *    hand's necklace is walked, calling that hand's figuration per onset.
 */

import type {
  ChordData,
  Note,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  chordPitches,
  nearestVoicing,
} from "@plugins/apps/plugins/sonata/plugins/theory/core";
import type { Figuration, FigurationContext } from "./figuration";
import type { HandVoicing } from "./hand-voicing";
import {
  findFiguration,
  DEFAULT_BASS_FIGURATION_ID,
  DEFAULT_CHORD_FIGURATION_ID,
} from "./figuration";

/** A parsed, timed chord (quarter-note beats) — the input to every voicing. */
export interface ChordEvent {
  data: ChordData;
  start: number;
  end: number;
}

export interface VoicingOptions {
  /** Octave for the chord root. C4 = middle C = MIDI 60. */
  octave: number;
  /** -> TrackMeta.id the derived notes belong to (the caller owns its track). */
  track: string;
  /**
   * -> TrackMeta.id the bass notes belong to, when the caller wants the bass on
   * a track separate from the upper structure (so it can be muted / hidden /
   * instrumented independently). Defaults to `track` when absent — bass and
   * chord tones then share one track, byte-for-byte with the original.
   */
  bassTrack?: string;
  /**
   * Note-id namespace, e.g. `"cg"` or `"ug"`. Ids are `${idPrefix}-${i}-${k}`;
   * each source picks its own prefix so derived notes never collide on id.
   */
  idPrefix: string;
  /** MIDI velocity for struck notes (default 80). */
  velocity?: number;
  /**
   * "Realistic" mode: voice-lead each chord to the nearest inversion of the
   * previous one (via `nearestVoicing`) and add a low bass root. When falsy
   * (the default) each chord plays in root position with no bass — the original
   * behaviour, byte-for-byte (same note ids/shape, no `voice` set).
   */
  voiceLead?: boolean;
  /**
   * Absolute onset beats per hand, sorted ascending. Resolved by reVoiceChords
   * from the bar grid — this module never learns about bars or time signatures.
   * When present, chords are struck on this bar-anchored necklace (a note per
   * onset in the chord in force) instead of one block note per chord event; when
   * absent the engine emits exactly today's block notes.
   */
  rhythm?: { bass: readonly number[]; chord: readonly number[] };
  /**
   * The per-hand tone-order pattern walked against {@link rhythm}. Present ONLY
   * alongside `rhythm` (a figuration is meaningless with no necklace to apply it
   * to). When absent on the groove path, defaults to `{bass:"root",
   * chord:"block"}`, reproducing today's rhythm behaviour (a low root per bass
   * onset, the whole chord per chord onset).
   */
  figuration?: { bass: Figuration; chord: Figuration };
  /**
   * Each hand's own voicing on the groove path (see {@link HandVoicing}): on/off,
   * register, voice-leading and octave doubling. Read ONLY alongside `rhythm`.
   * When absent, the chord hand takes `octave` / `voiceLead` and the bass hand
   * sits at {@link BASS_OCTAVE} without voice-leading — today's groove sound.
   */
  hands?: { bass: HandVoicing; chord: HandVoicing };
}

/**
 * A bass note is emitted when the voicing is voice-led OR a rhythm is active —
 * a left-hand groove with no bass note would be inert. Decoupling bass from
 * `voiceLead` makes that impossible.
 */
const wantsBass = (o: VoicingOptions) => !!o.voiceLead || !!o.rhythm;

const DEFAULT_VELOCITY = 80;

/** Octave the bass root sits in — roughly 1–2 octaves below the voiced chord. */
const BASS_OCTAVE = 2;

/** Highest MIDI pitch; an octave double above it is dropped, never wrapped. */
const MAX_PITCH = 127;

/**
 * Shift a root-position bass register by whole octaves so its root lands nearest
 * `prevRoot`, never more than an octave from where the register was placed
 * (`tones`, at the hand's own octave) — so a line of falling fourths cannot walk
 * the bass off the keyboard. A tie keeps the placed register.
 */
function nearestOctave(tones: number[], prevRoot: number | null): number[] {
  const root = tones[0];
  if (prevRoot === null || root === undefined) return tones;
  let best = 0;
  for (const shift of [-12, 12]) {
    if (Math.abs(root + shift - prevRoot) < Math.abs(root + best - prevRoot)) {
      best = shift;
    }
  }
  return best === 0 ? tones : tones.map((p) => p + best);
}

/**
 * The struck tones plus, when the hand doubles at the octave, each one an octave
 * above (`k` suffixed `o`, so a doubled pitch never collides on id).
 */
function withOctaveDouble(
  struck: readonly { pitch: number; k: number }[],
  double: boolean,
): { pitch: number; k: string }[] {
  const base = struck.map(({ pitch, k }) => ({ pitch, k: String(k) }));
  if (!double) return base;
  return [
    ...base,
    ...struck
      .filter(({ pitch }) => pitch + 12 <= MAX_PITCH)
      .map(({ pitch, k }) => ({ pitch: pitch + 12, k: `${k}o` })),
  ];
}

/**
 * Place a bass pitch-class in the low register: the given pitch-class at
 * `BASS_OCTAVE` (C2 = MIDI 36). Carries the chord root (or the slash-chord bass
 * when present) under the voiced upper structure.
 */
function lowBassPitch(pc: number): number {
  return 12 * (BASS_OCTAVE + 1) + (((pc % 12) + 12) % 12);
}

/** One placed chord: the voiced upper structure plus an optional bass root. */
interface PlacedVoicing {
  pitches: number[];
  bass: number | null;
}

/**
 * Shared placement loop for every strategy. For each event it computes the
 * root-position tone set via `tonesOf`, then either voice-leads it to the
 * previous chord with a bass root (`voiceLead` on) or leaves it in root position
 * with no bass (off). Strategies own the *rhythm* over `pitches`; this owns the
 * *pitch placement*, so voice-leading is one orthogonal modifier shared by all.
 */
function placeVoicings(
  events: ChordEvent[],
  opts: VoicingOptions,
  tonesOf: (ev: ChordEvent) => number[],
): PlacedVoicing[] {
  let prevVoiced: number[] | null = null;
  return events.map((ev) => {
    const tones = tonesOf(ev);
    // Voice-leading advances `prevVoiced`; root position leaves it untouched so
    // it stays byte-for-byte with the original behaviour. Bass placement is
    // orthogonal: emitted whenever voice-leading OR a rhythm wants it.
    const pitches = opts.voiceLead ? nearestVoicing(tones, prevVoiced) : tones;
    if (opts.voiceLead) prevVoiced = pitches;
    const bass = wantsBass(opts)
      ? lowBassPitch(ev.data.bass ?? ev.data.root)
      : null;
    return { pitches, bass };
  });
}

/**
 * Emit the bass note for a placed chord, or `[]` when there is none. The bass is
 * a block note spanning the full chord duration on `bassTrack` (falling back to
 * `track`), `voice: 0`, with a `-b`-suffixed id so it never collides with the
 * upper-structure notes.
 */
function bassNote(
  ev: ChordEvent,
  placed: PlacedVoicing,
  i: number,
  { track, bassTrack, idPrefix, velocity = DEFAULT_VELOCITY }: VoicingOptions,
): Note[] {
  if (placed.bass === null) return [];
  return [
    {
      id: `${idPrefix}-${i}-b`,
      pitch: placed.bass,
      start: ev.start,
      duration: ev.end - ev.start,
      velocity,
      track: bassTrack ?? track,
      voice: 0,
    },
  ];
}

/**
 * Upper-structure voice for a note: `1` whenever a bass is present (voice-led or
 * rhythmic), so bass (`voice: 0`) and upper structure stay on distinct voices;
 * `undefined` in the plain root-position path (byte-for-byte with the original).
 */
function upperVoice(opts: VoicingOptions): number | undefined {
  return wantsBass(opts) ? 1 : undefined;
}

/** What `emitRhythmicHand` reports to `build` for one struck onset. */
interface OnsetSlot {
  /** Index into `events` of the chord in force at this onset. */
  evIndex: number;
  /** Running index over the whole necklace (never reset per chord). */
  onsetIndex: number;
  /** 0-based ordinal of this onset within its chord (reset when `evIndex` advances). */
  positionInChord: number;
  /** True on the first struck onset of the chord (`positionInChord === 0`). */
  firstOnsetOfChord: boolean;
  /** True when no further onset sounds within this chord. */
  lastOnsetBeforeChange: boolean;
  start: number;
  duration: number;
}

/**
 * Shared bar-anchored onset emitter for the groove path. The necklace is anchored
 * to the ABSOLUTE bar grid and does NOT restart per chord: this walks a hand's
 * absolute onset beats against the sorted chord events (O(n+m) pointer merge) and,
 * for each onset that falls inside a chord, builds notes via `build`. An onset in
 * a gap (before the first chord / after the last) is genuine silence and skipped.
 * The note duration is clipped to the chord's end so a note never rings across a
 * chord change. `events` are pre-sorted by `start` and non-overlapping (chord
 * annotations), and `onsets` are sorted ascending — so the pointer only advances.
 *
 * Two figuration signals are derived in the same single pass, at no extra cost:
 *  - `positionInChord` — reset to 0 whenever the matched event index advances,
 *    else incremented (silent gap onsets never advance it). So it counts *struck*
 *    onsets since this chord began — which, within a chord's range, is exactly its
 *    onset ordinal. Lets a cyclic figure restart on each chord's own root.
 *  - `lastOnsetBeforeChange` — a one-step peek: true when the next onset is absent
 *    (`Infinity`) or lands at/after this chord's end (a later event or a gap), i.e.
 *    no further onset sounds under this chord. Walking bass's approach-tone signal.
 */
function emitRhythmicHand(
  events: ChordEvent[],
  onsets: readonly number[],
  build: (slot: OnsetSlot) => Note[],
): Note[] {
  const out: Note[] = [];
  let j = 0;
  let prevEvIndex = -1;
  let positionInChord = -1;
  for (let i = 0; i < onsets.length; i++) {
    const b = onsets[i]!;
    while (j < events.length && events[j]!.end <= b) j++;
    const ev = events[j];
    if (!ev || b < ev.start || b >= ev.end) continue; // silence — no chord here
    // Reset the within-chord ordinal when the matched event advances; otherwise
    // advance it. Silent onsets `continue` above, so they never touch it.
    if (j !== prevEvIndex) {
      positionInChord = 0;
      prevEvIndex = j;
    } else {
      positionInChord++;
    }
    const nextOnset = i + 1 < onsets.length ? onsets[i + 1]! : Infinity;
    const duration = Math.min(nextOnset, ev.end) - b;
    out.push(
      ...build({
        evIndex: j,
        onsetIndex: i,
        positionInChord,
        firstOnsetOfChord: positionInChord === 0,
        // No further onset sounds within this chord ⇒ next onset is at/after its end.
        lastOnsetBeforeChange: nextOnset >= ev.end,
        start: b,
        duration,
      }),
    );
  }
  return out;
}

/**
 * Regenerate performed notes from timed chord events under `opts`.
 *
 * No-groove path (`opts.rhythm` absent): byte-for-byte the historical block
 * behaviour — one block note per placed tone per chord, held for the chord's full
 * duration, with a bass root iff `voiceLead`. (Ids `${idPrefix}-${i}-${k}`, bass
 * `${idPrefix}-${i}-b`.)
 *
 * Groove path (`opts.rhythm` present): two tone-sets are placed per event — the
 * voice-led chord register (`nearestVoicing` when `voiceLead`, chord hand only)
 * and a low root-position bass register — then each hand's necklace is walked,
 * calling that hand's {@link Figuration} per onset. Chord notes land on
 * `opts.track` (`voice: upperVoice`); bass notes on `opts.bassTrack ?? opts.track`
 * (`voice: 0`). Ids are onset-indexed: chord `${idPrefix}-c${onset}-${k}`, bass
 * `${idPrefix}-b${onset}-${k}` (the `-${k}` since a bass figuration can strike a
 * dyad / stab; a doubled pitch's `k` ends in `o`). Absent `opts.figuration`
 * defaults to `{bass:"root",chord:"block"}`; each hand's register, voice-leading,
 * octave doubling and on/off come from `opts.hands`.
 */
export function voiceChords(
  events: ChordEvent[],
  opts: VoicingOptions,
): Note[] {
  const { track, bassTrack, idPrefix, velocity = DEFAULT_VELOCITY } = opts;
  const voice = upperVoice(opts);

  if (!opts.rhythm) {
    // No-groove path — one block note per placed tone per chord, bass root iff
    // voiceLead. A figuration only bites when a necklace exists.
    const placed = placeVoicings(events, opts, (ev) =>
      chordPitches(ev.data, opts.octave),
    );
    return events.flatMap((ev, i) => [
      ...placed[i]!.pitches.map((pitch, k) => ({
        id: `${idPrefix}-${i}-${k}`,
        pitch,
        start: ev.start,
        duration: ev.end - ev.start,
        velocity,
        track,
        voice,
      })),
      ...bassNote(ev, placed[i]!, i, opts),
    ]);
  }

  const rhythm = opts.rhythm;
  const figuration = opts.figuration ?? {
    bass: findFiguration(DEFAULT_BASS_FIGURATION_ID),
    chord: findFiguration(DEFAULT_CHORD_FIGURATION_ID),
  };
  const hands = opts.hands ?? {
    chord: {
      enabled: true,
      octave: opts.octave,
      voiceLead: !!opts.voiceLead,
      doubleOctave: false,
    },
    bass: {
      enabled: true,
      octave: BASS_OCTAVE,
      voiceLead: false,
      doubleOctave: false,
    },
  };

  // Place BOTH registers per event, each at its hand's octave: the chord
  // register (voice-led to the nearest inversion when the chord hand asks) and
  // the root-position bass register (moved by whole octaves to the nearest root
  // when the bass hand asks). Both are placed even for a hand that is off, since
  // a figuration may reach across registers.
  let prevVoiced: number[] | null = null;
  let prevBassRoot: number | null = null;
  const chordPlaced: number[][] = [];
  const bassPlaced: number[][] = [];
  for (const ev of events) {
    const tones = chordPitches(ev.data, hands.chord.octave);
    const voiced: number[] = hands.chord.voiceLead
      ? nearestVoicing(tones, prevVoiced)
      : tones;
    if (hands.chord.voiceLead) prevVoiced = voiced;
    chordPlaced.push(voiced);
    const bassTones = chordPitches(ev.data, hands.bass.octave);
    const bass: number[] = hands.bass.voiceLead
      ? nearestOctave(bassTones, prevBassRoot)
      : bassTones;
    if (hands.bass.voiceLead) prevBassRoot = bass[0] ?? null;
    bassPlaced.push(bass);
  }

  // Build the per-onset context for the hand whose register is `active`: `tones`
  // / `tonesOfNext` follow that hand (chord register on the chord hand, bass
  // register on the bass hand) so a figuration adapts to whichever hand it is
  // placed on; both placed registers stay available for explicit cross-register
  // reach (an `{all, reg:"chord"}` stab).
  const contextAt = (
    slot: OnsetSlot,
    active: "chord" | "bass",
  ): FigurationContext => {
    const chordTones = chordPlaced[slot.evIndex]!;
    const bassTones = bassPlaced[slot.evIndex]!;
    const chordTonesOfNext = chordPlaced[slot.evIndex + 1] ?? [];
    const bassTonesOfNext = bassPlaced[slot.evIndex + 1] ?? [];
    return {
      chord: events[slot.evIndex]!.data,
      tones: active === "chord" ? chordTones : bassTones,
      tonesOfNext: active === "chord" ? chordTonesOfNext : bassTonesOfNext,
      chordTones,
      bassTones,
      onsetIndex: slot.onsetIndex,
      positionInChord: slot.positionInChord,
      nextChord: events[slot.evIndex + 1]?.data ?? null,
      firstOnsetOfChord: slot.firstOnsetOfChord,
      lastOnsetBeforeChange: slot.lastOnsetBeforeChange,
    };
  };

  // A hand that is off strikes nothing: its necklace is walked over no onsets.
  const chordNotes = emitRhythmicHand(
    events,
    hands.chord.enabled ? rhythm.chord : [],
    (slot) =>
      withOctaveDouble(
        figuration.chord.select(contextAt(slot, "chord")),
        hands.chord.doubleOctave,
      ).map(({ pitch, k }) => ({
        id: `${idPrefix}-c${slot.onsetIndex}-${k}`,
        pitch,
        start: slot.start,
        duration: slot.duration,
        velocity,
        track,
        voice,
      })),
  );

  const bassNotes = emitRhythmicHand(
    events,
    hands.bass.enabled ? rhythm.bass : [],
    (slot) =>
      withOctaveDouble(
        figuration.bass.select(contextAt(slot, "bass")),
        hands.bass.doubleOctave,
      ).map(({ pitch, k }) => ({
        id: `${idPrefix}-b${slot.onsetIndex}-${k}`,
        pitch,
        start: slot.start,
        duration: slot.duration,
        velocity,
        track: bassTrack ?? track,
        voice: 0,
      })),
  );

  return [...chordNotes, ...bassNotes];
}
