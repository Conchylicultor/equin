/**
 * The Sonata `Score` IR — the narrow waist of the Sonata pipeline.
 *
 * Pure TypeScript: no React, no framework, no UI. Every input source compiles
 * *into* a `Score`; every display reads *from* one. That collapses N inputs ×
 * M displays into N+M integrations (the compiler pattern: many front-ends → one
 * IR → many back-ends).
 *
 * The Score has two layers, and the split is the load-bearing idea:
 *  - `notes`       — the literal pitches over time (what plays / what the roll draws)
 *  - `annotations` — typed, time-ranged *meaning* on top of the notes (chord
 *    symbols, voicings, sections, key). This is the "rich display" data.
 *
 * Either layer can be authored or derived, so any display can render notes,
 * chord names, or both — regardless of which input authored what. Every
 * annotation records its `source` so a display can badge inferred data and an
 * Analyzer never clobbers authored truth.
 *
 * This module is the DAG leaf: it depends on nothing. Display-agnostic
 * rich-display contracts (`Capability`, `Projection`) live here too — NOT in the
 * piano-roll plugin — so analyzers/overlays import them via the barrel without
 * deep-importing a display's internals.
 */

import type { PitchPlane } from "./pitch-plane";

// ---------------------------------------------------------------------------
// Full IR
// ---------------------------------------------------------------------------

/** A key signature, e.g. `{ tonic: "C", mode: "major" }`. */
export interface KeySignature {
  /** Tonic note name, e.g. "C", "F#", "Bb". */
  tonic: string;
  mode: "major" | "minor";
}

/** How a MIDI pitch is spelled on the staff (MIDI 61 is C#4 *or* Db4). */
export interface PitchSpelling {
  /** Diatonic step letter. */
  step: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  /** Chromatic alteration in semitones: -1 = flat, 0 = natural, +1 = sharp. */
  alter: number;
  /** Scientific octave (middle C = C4). */
  octave: number;
}

/** A part / instrument. MIDI channel, sheet part, etc. */
export interface TrackMeta {
  id: string;
  name?: string;
  instrumentHint?: string;
  /**
   * General MIDI program number (0-127) of the track's instrument, when the
   * source carries one. The audio layer auto-maps this to a registered timbre;
   * `instrumentHint` is the human-readable counterpart used for display.
   */
  gmProgram?: number;
}

/** A piecewise-constant tempo segment: from `beat` onward, the tempo is `bpm`. */
export type TempoEvent = { beat: number; bpm: number };

/** A time-signature change taking effect at `beat`. */
export type TimeSigEvent = {
  beat: number;
  numerator: number;
  denominator: number;
};

/**
 * A sustain (damper) pedal state change on a track, at `beat`.
 *
 * This is a **continuous-controller lane** on the Score — the sustain pedal's
 * MIDI CC64. It is deliberately a first-class layer, NOT baked into note
 * durations: the audio layer reads it to extend a note's *sounding* time
 * ({@link resolvePedalSustain}) while the note's authored `duration` (its
 * *notated* length) stays untouched, and the display layer reads the SAME lane
 * to draw pedal marks. One source of truth for "when is the pedal down".
 *
 * `down` is the resolved boolean (MIDI convention: CC64 value ≥ 64 = down).
 * Events are kept sorted ascending by `beat`, per-track (CC64 is per channel).
 */
export type PedalEvent = { track: string; beat: number; down: boolean };

/** A single literal pitch event. */
export interface Note {
  /** Stable identity — annotations target notes by id and survive re-analysis. */
  id: string;
  /** MIDI note number (always present). */
  pitch: number;
  /** Staff spelling when known/inferred; raw MIDI may leave it undefined. */
  spelling?: PitchSpelling;
  /** Start in quarter-note beats (1.0 = one quarter note). */
  start: number;
  /** Duration in quarter-note beats. */
  duration: number;
  /** MIDI velocity (0–127). */
  velocity: number;
  /** -> TrackMeta.id (the part this note belongs to). */
  track: string;
  /** Melodic line within a track (an independent axis from `track`). */
  voice?: number;
}

/** Discriminated `data` payloads for built-in annotation types. */
// `symbol` is the normalized (sharps) name — always present and the primary
// label every display shows. `spelledSymbol` is the key-aware enharmonic
// refinement (e.g. `B♭m` where `symbol` is `A#m`), present *only* when a key
// context yields a spelling that differs from `symbol`; otherwise omitted.
// `bass` is the pitch-class in the bass when it differs from the root (an
// inversion / slash chord, e.g. `C/E`); present *only* on a genuine inversion
// where the bass is a chord tone, otherwise omitted. The slash is already baked
// into `symbol`/`spelledSymbol`, so displays need not special-case it.
export type ChordData = {
  symbol: string;
  root: number;
  quality: string;
  bass?: number;
  spelledSymbol?: string;
  /**
   * Realised semitones above the root (root excluded, ascending). Set by the
   * chord-symbol parser only when the chord is altered beyond its base `quality`
   * (parenthetical alterations / add / omit / sus-on-a-7th). Absent for plain
   * qualities, whose intervals derive from `quality` via `qualityToIntervals`.
   */
  intervals?: readonly number[];
};
export type VoicingData = { label?: string }; // targets notes via target.noteIds
export type SectionData = { name: string };
/** A chord printed over a lyric line at a visible character column. */
export type LyricChord = {
  /** Chord symbol as written/displayed, verbatim (e.g. "Cmaj7", "N.C."). */
  symbol: string;
  /** 0-based visible column in `text` where the chord sits (may exceed text.length). */
  charOffset: number;
  /** Beat the chord sounds on — syncs the active-chord highlight to the cursor. */
  beat: number;
};

// A faithful songsheet line over its beat range — one line/phrase of words a
// songsheet renders WITH the chords printed over it by column. The
// `Annotation.start`/`end` carry the timing (synthesized for sources, like UG,
// that ship no timing of their own); `text` is the literal words (leading
// columns load-bearing for chord alignment) and `chords` are the chord symbols
// printed above it, each anchored to a visible character column. A chord-only /
// instrumental line is a songsheet line too: `text` is empty, `chords`
// populated. Sources with no lyrics simply emit none.
export type LyricData = { text: string; chords: LyricChord[] };

/**
 * Typed, time-ranged meaning layered on top of the notes.
 *
 * `T` is the discriminating `type` tag and `D` its `data` shape. The built-in
 * union (`chord` | `voicing` | `section` | `lyric`) declares its `data` here so
 * overlays get type-safe payloads — the one place a little central coupling pays off.
 */
export interface Annotation<T extends string = string, D = unknown> {
  /** "chord" | "voicing" | "section" | "key" | … */
  type: T;
  /** Start in beats. */
  start: number;
  /** End in beats. */
  end: number;
  /** Optional anchor onto specific notes / track / voice. */
  target?: { noteIds?: string[]; track?: string; voice?: number };
  data: D;
  /** Whether this is authored truth or analyzer-derived. */
  source: "authored" | "derived";
  /** Optional [0,1] confidence for derived annotations. */
  confidence?: number;
}

/** Convenience aliases for the built-in annotation shapes. */
export type ChordAnnotation = Annotation<"chord", ChordData>;
export type VoicingAnnotation = Annotation<"voicing", VoicingData>;
export type SectionAnnotation = Annotation<"section", SectionData>;
export type LyricAnnotation = Annotation<"lyric", LyricData>;

/**
 * The recording a Score's timeline is measured on: at tempo scale 1, score
 * seconds ARE media seconds — `beatToSeconds(score, b)` is the time in the
 * recording at which beat `b` sounds. It names a timebase, not how the timing
 * was obtained, so a display or the transport may play the recording beside the
 * Score without knowing anything about alignment. Meaningful only together with
 * the Score's own `tempoMap` (see `mergeScores`). At a tempo scale `s`, media
 * seconds are score seconds × `s`.
 */
export interface ScoreRecording {
  provider: "youtube";
  videoId: string;
  /** The recording's length, in seconds. */
  durationSec: number;
}

/**
 * A swing feel: how the score's straight off-beats are PLAYED. Notation stays
 * straight (every display reads the authored `start`); only the audio layer
 * applies it, through `swingNotes` at the playback boundary.
 *
 * `unit` is the swung note value (8 = swung eighths, 16 = swung sixteenths);
 * each pair of `unit` notes is played `ratio : 1` (2 = the triplet swing of a
 * jazz chart, 1 = straight, 3 = a hard dotted-eighth-sixteenth shuffle).
 */
export interface Swing {
  unit: 8 | 16;
  ratio: number;
}

/** The canonical in-memory model — the narrow waist. */
export interface Score {
  meta: {
    title?: string;
    key?: KeySignature;
    pickupBeats?: number;
    /** The recording this Score's tempo map is measured on, if any. */
    recording?: ScoreRecording;
    /** The swing feel the notes are played with; absent = straight. */
    swing?: Swing;
  };
  /** Parts / instruments. */
  tracks: TrackMeta[];
  /** Sorted, piecewise-constant — NOT a single bpm. */
  tempoMap: TempoEvent[];
  /** Sorted — NOT a single time signature. */
  timeSigMap: TimeSigEvent[];
  notes: Note[];
  annotations: Annotation[];
  /**
   * Sustain-pedal (CC64) state changes, sorted ascending by `beat`, per track.
   * Empty when the source authored no pedaling. The audio layer extends note
   * sustain from this lane; displays draw pedal marks from it. See
   * {@link PedalEvent}.
   */
  pedalEvents: PedalEvent[];
}

// ---------------------------------------------------------------------------
// Transport position + the A–B loop cycle (pure maths in `loop-cycle.ts`)
// ---------------------------------------------------------------------------

/**
 * An A–B practice loop as the transport CYCLES it, in beats — the one shared
 * definition the cursor's time-fold, the audio / metronome schedulers and the
 * displays all read, so they agree on what plays after `B` by construction.
 *
 * Every repeat of the loop is one iteration of `[start - rest, end)`: `rest`
 * beats of silence (nothing sounds, nothing is drawn as being played) leading
 * into `start` (A), then the loop body `[start, end)`. The first pass is the
 * song itself, from wherever playback started up to `end` (B), so a start
 * before A plays the real song (including the bar the rest replaces on a
 * repeat) straight into the loop.
 *
 * The rest is timed by the score's own tempo map over `[start - rest, start)`,
 * so every consumer integrating the same span through the same tempo index
 * gets the same iteration length. `rest` is `0` for a seamless B→A wrap.
 */
export interface LoopCycle {
  /** A — the loop body's first beat. */
  start: number;
  /** B — the loop body's end (exclusive). Always `> start`. */
  end: number;
  /** Beats of silence before every repeat of the body (`>= 0`). */
  rest: number;
}

/**
 * Where the transport is — what the playback cursor holds.
 *
 *  - `beat` is the SCORE position: the beat sounding now, or, during a loop's
 *    rest, the beat about to sound (A). Score-domain readers (a chord chart, a
 *    readout, the progress bar) read only this, so they park on A during a rest.
 *  - `rest` is how many beats of the loop's rest remain before `beat` sounds:
 *    `0` while notes play, `> 0` only inside a rest. Whatever shows what is
 *    BEING PLAYED (lit keys, highlighted noteheads) shows nothing while it is
 *    positive.
 *  - `repeat` is whether this is a repeat pass of the loop (after its first
 *    wrap) rather than the song's own pass — what a display that unrolls the
 *    loop ahead needs to place the cursor (see {@link AxisTimeline}).
 */
export interface PlayPosition {
  beat: number;
  rest: number;
  repeat: boolean;
}

// ---------------------------------------------------------------------------
// Rich-display contracts (display-agnostic, kept here to keep the graph a DAG)
// ---------------------------------------------------------------------------

/**
 * A capability a Display offers. An Overlay declares the capabilities it
 * `requires`; the overlay host renders it only when its requirements are a
 * subset of the display's capabilities. Grows when staff / fretboard land.
 */
export type Capability = "time-axis" | "pitch-plane";

/**
 * Geometry a Display publishes (via React context) so capability-compatible
 * overlays and pitch-axis decorations can anchor themselves to display
 * coordinates without knowing which display they're on. Optional accessors are
 * present iff the matching capability is offered.
 *
 * The piano roll is VERTICAL: time grows downward (Y) and pitch spans the full
 * 88-key keyboard horizontally (X). The accessor names reflect that screen
 * mapping; the capability names (`"time-axis"`, `"pitch-plane"`) stay semantic.
 */
export interface Projection {
  capabilities: ReadonlySet<Capability>;
  /** Lane pixel dimensions. Content-space and cursor-invariant — no scroll
   * position lives here; the playback cursor is applied as a translate by the
   * display, never baked into the projection. */
  viewport: { width: number; height: number };
  /** Present iff "time-axis": beat → screen Y (px from the top of the lane). */
  beatToY?: (beat: number) => number;
  /**
   * Present iff "time-axis": the exact inverse of {@link beatToY} — a
   * content-space Y (px) back to its beat. Lets an overlay turn a pointer
   * position on the lane into a beat (e.g. dragging a loop boundary).
   */
  yToBeat?: (y: number) => number;
  /**
   * Present iff "pitch-plane": pitch → screen X (px, column center), or `null`
   * when this axis does not carry that pitch. A missing pitch is a real
   * possibility (a display shows a range, a score may not respect it), and it
   * used to degrade into a white-key-wide bar pinned at x=0 — a fabricated
   * position indistinguishable from a real one. `null` says "not on this axis"
   * and consumers drop the note instead of drawing it somewhere false.
   */
  pitchToX?: (pitch: number) => number | null;
  /** Present iff both axes. `null` when the pitch is not on this axis. */
  noteToRect?: (
    note: Note,
  ) => { x: number; y: number; w: number; h: number } | null;
  /**
   * Present iff "pitch-plane": the pads, note columns and orientation rules the
   * pitch axis was laid out with — the SAME plane the display built its own
   * columns from, so a keyboard rendered from it lands on the falling notes by
   * construction rather than by re-deriving a matching range.
   */
  pitchPlane?: PitchPlane;
  /**
   * Present iff "time-axis": what the time axis lays out. The beats
   * `beatToY` / `yToBeat` speak are AXIS beats; for a display drawing the song
   * as written they are the score's beats, but the piano roll may unroll an
   * A–B loop ahead of the cursor (`unrollLoop`), drawing copies of the loop past
   * B. Anything anchored to the transport maps through this rather than
   * assuming the identity: the cursor's axis beat is
   * `timeline.axisBeat(position)`, and a pointer's axis beat reads back as the
   * play position shown there with `timeline.at(axisBeat)`.
   */
  timeline?: AxisTimeline;
}

/**
 * How a display's time axis lays out the transport: axis beats ↔ play
 * positions. The identity for a display drawing the song as written; an
 * unrolled A–B loop otherwise (see `unrollLoop` in `loop-timeline.ts`).
 */
export interface AxisTimeline {
  /** The axis beat a play position sits at (where the cursor is drawn). */
  axisBeat(position: PlayPosition): number;
  /**
   * The play position the axis shows at `axisBeat` — the inverse of
   * {@link axisBeat}: a song beat, a beat of a drawn loop copy (`repeat`), or
   * a point inside a drawn rest (`rest > 0`, `beat` = A).
   */
  at(axisBeat: number): PlayPosition;
  /**
   * The unrolled loop, or `null` when the axis draws the song as written.
   * `shifts[k]` is copy k's offset (axis beat − score beat): copy k's body
   * spans `[cycle.start, cycle.end) + shifts[k]`, its rest the `cycle.rest`
   * beats just before it.
   */
  loop: { cycle: LoopCycle; shifts: readonly number[] } | null;
}
