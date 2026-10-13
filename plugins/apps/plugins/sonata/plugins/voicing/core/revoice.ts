/**
 * The single chord-note generation chokepoint.
 *
 * Symbol-based sources (chord-grid, Ultimate Guitar, …) emit chord
 * *annotations* only; this step regenerates the chord *notes* from those
 * annotations under the global voicing config. Run reactively in the shell
 * (before key inference, so chord notes exist for detection), it makes
 * the accompaniment an orthogonal modifier applied uniformly to every symbol source
 * — zero per-source code. The shell runs it a second time, after analysis, with
 * `include: "all"` when a song's chord mode is on — so a MIDI song's DETECTED
 * chords become playable notes through the very same groove.
 *
 * Pure and framework-free: a new `Score` in, a new `Score` out; the input is
 * never mutated.
 */

import type {
  Annotation,
  ChordAnnotation,
  Note,
  Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  bars,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type {
  RhythmHands,
  RhythmPattern,
} from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import { effectiveOnsets } from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import { voiceChords, type ChordEvent, type VoicingOptions } from "./voicing";
import { findFiguration } from "./figuration";
import type { HandVoicing } from "./hand-voicing";

/**
 * The synthesized track the re-voiced chord (upper-structure) notes live on.
 * Distinct from any source's own track id (e.g. chord-grid's `cg0`), since this
 * chokepoint — not the source — now owns chord notes. The bass root lives on its
 * own {@link CHORD_BASS_TRACK}, so the two can be muted / hidden / instrumented
 * independently through the generic track-mixer.
 */
export const CHORD_TRACK = "chords";

/**
 * The synthesized track the re-voiced bass root lives on — split out from
 * {@link CHORD_TRACK} so bass and chords are independently controllable in the
 * mixer. Bass notes only exist when a voicing wants them (voice-leading on, or a
 * rhythm hand active); with neither, this track carries no notes.
 */
export const CHORD_BASS_TRACK = "chords-bass";

/** Note-id namespace for re-voiced chord notes (see VoicingOptions.idPrefix). */
const CHORD_NOTE_PREFIX = "chord";

function isChord(a: Annotation): a is ChordAnnotation {
  return a.type === "chord";
}

/**
 * Which chord annotations the pass voices.
 *  - `"authored"` (default) — symbol-source chords only: the historical
 *    behaviour, run before key inference so authored chord notes exist for
 *    detection while analyzer-derived chords stay labels.
 *  - `"all"` — every chord annotation, authored AND analyzer-derived. The
 *    chord-mode pass the shell runs AFTER analysis on a MIDI song, so the
 *    detected chords become playable notes. One pass over all of them keeps
 *    voice-leading continuous across a mixed song (chord grid + MIDI).
 */
export type ReVoiceInclude = "authored" | "all";

export interface ReVoiceOptions {
  include?: ReVoiceInclude;
}

function chordSelector(
  include: ReVoiceInclude,
): (a: Annotation) => a is ChordAnnotation {
  if (include === "all") return isChord;
  return (a): a is ChordAnnotation => isChord(a) && a.source === "authored";
}

/**
 * Re-anchor each voiced chord annotation onto the notes this pass generated for
 * it: the chord-track notes whose onset falls inside the chord's span. A derived
 * chord arrives targeting the ORIGINAL notes it was detected from; once voiced,
 * those are no longer the notes that sound it (chord mode hides them), so leaving
 * the old ids would be a dangling reference for the next consumer that reads
 * `target.noteIds`. Both inputs are sorted by start, so this is one merge sweep.
 */
function retargetVoiced(
  annotations: Annotation[],
  voiced: ReadonlySet<Annotation>,
  chordNotes: readonly Note[],
): Annotation[] {
  const sorted = [...chordNotes].sort((a, b) => a.start - b.start);
  return annotations.map((a) => {
    if (!voiced.has(a)) return a;
    const noteIds: string[] = [];
    for (const n of sorted) {
      if (n.start >= a.end) break;
      if (n.start >= a.start) noteIds.push(n.id);
    }
    return { ...a, target: { ...a.target, noteIds } };
  });
}

/**
 * One cycle of a groove's necklace: it starts at `start`, is cut off at `end`
 * (exclusive), and its pulses are spaced as if it lasted `span` beats — the
 * length of the bar it falls in, so a restarted cycle keeps the bar's pulse.
 */
export interface GrooveCycle {
  start: number;
  end: number;
  span: number;
}

/** Whether a chord change starts the necklace over, and which chords count. */
export interface GrooveCycleOptions {
  /**
   * When true, every chord change that falls inside a bar starts the necklace
   * over from its first pulse (cut off at the next change or bar line, where
   * the bar grid takes over again), so a chord that changes mid-bar is struck
   * on its own change even when no onset of the bar grid falls under it. When
   * false the necklace is anchored to bar lines only.
   */
  restartOnChordChange: boolean;
  /** Which chord annotations are voiced (default: authored only). */
  include?: ReVoiceInclude;
}

/**
 * The groove's cycles over a score, sorted ascending: one per bar (bars from
 * `bars()`, time-signature aware; the final bar runs to `scoreEndBeat`), each
 * split at the voiced chords' changes when `restartOnChordChange`. The single
 * definition of where the necklace starts — the engine strikes onsets on it,
 * and the rhythm circle spins on it, so the two cannot disagree.
 */
export function grooveCycles(
  score: Score,
  opts: GrooveCycleOptions,
): GrooveCycle[] {
  const barList = bars(score);
  const end = scoreEndBeat(score);
  const changes = opts.restartOnChordChange
    ? [
        ...new Set(
          score.annotations
            .filter(chordSelector(opts.include ?? "authored"))
            .map((a) => a.start),
        ),
      ].sort((a, b) => a - b)
    : [];
  const cycles: GrooveCycle[] = [];
  let c = 0;
  for (let i = 0; i < barList.length; i++) {
    const start = barList[i]!.startBeat;
    const next = i + 1 < barList.length ? barList[i + 1]!.startBeat : end;
    const span = next - start;
    if (span <= 0) continue; // skip a degenerate (zero/negative-length) bar
    while (c < changes.length && changes[c]! <= start) c++;
    let anchor = start;
    while (c < changes.length && changes[c]! < next) {
      cycles.push({ start: anchor, end: changes[c]!, span });
      anchor = changes[c]!;
      c++;
    }
    cycles.push({ start: anchor, end: next, span });
  }
  return cycles;
}

/**
 * Resolve one rhythm pattern to absolute onset beats on the groove's cycles:
 * within each cycle an effective onset `k` lands at `start + span·k/subdivisions`,
 * kept only while it falls before the cycle's end. Cycles are sorted and
 * contiguous, so the concatenation is already sorted ascending.
 */
function resolvePattern(
  cycles: readonly GrooveCycle[],
  pattern: RhythmPattern,
): number[] {
  const onsets = effectiveOnsets(pattern);
  const beats: number[] = [];
  for (const cycle of cycles) {
    for (const k of onsets) {
      const beat = cycle.start + (cycle.span * k) / pattern.subdivisions;
      if (beat >= cycle.end) break; // onsets are sorted: the rest are cut too
      beats.push(beat);
    }
  }
  return beats;
}

/**
 * The accompaniment a song's chords are played with: each hand's rhythm
 * necklace (the *when*), tone-order figuration (the *what*) and voicing (the
 * *where*), plus whether a chord change starts the necklace over.
 */
export interface ReVoiceGroove {
  hands: RhythmHands;
  bassFigurationId: string;
  chordFigurationId: string;
  bassVoicing: HandVoicing;
  chordVoicing: HandVoicing;
  restartOnChordChange: boolean;
}

/**
 * Regenerate chord notes from a score's chord annotations under `groove`,
 * returning a new `Score`. Which annotations count is `opts.include` (default:
 * authored only — see {@link ReVoiceInclude}). All other tracks, notes, and
 * annotations are kept intact; only notes on {@link CHORD_TRACK} /
 * {@link CHORD_BASS_TRACK} are replaced (so a second pass replaces, never
 * duplicates), a `TrackMeta` for each is ensured, and every voiced chord
 * annotation is re-targeted at the notes generated for it. When the score has
 * no selected chord annotations the input is returned unchanged.
 *
 * Each hand's pattern is resolved to absolute onset beats on the groove's
 * cycles ({@link grooveCycles}) and its figuration id to a {@link Figuration},
 * so each hand strikes its own tone-ordered groove; its register,
 * voice-leading, octave doubling and on/off are its own voicing.
 */
export function reVoiceChords(
  score: Score,
  groove: ReVoiceGroove,
  opts?: ReVoiceOptions,
): Score {
  const include = opts?.include ?? "authored";
  const selected = score.annotations.filter(chordSelector(include));
  const events: ChordEvent[] = selected
    .map((a) => ({ data: a.data, start: a.start, end: a.end }))
    .sort((x, y) => x.start - y.start);

  if (events.length === 0) return score;

  const cycles = grooveCycles(score, {
    restartOnChordChange: groove.restartOnChordChange,
    include,
  });
  const voicingOpts: VoicingOptions = {
    octave: groove.chordVoicing.octave,
    voiceLead: groove.chordVoicing.voiceLead,
    track: CHORD_TRACK,
    bassTrack: CHORD_BASS_TRACK,
    idPrefix: CHORD_NOTE_PREFIX,
    rhythm: {
      bass: resolvePattern(cycles, groove.hands.bass),
      chord: resolvePattern(cycles, groove.hands.chord),
    },
    figuration: {
      bass: findFiguration(groove.bassFigurationId),
      chord: findFiguration(groove.chordFigurationId),
    },
    hands: { bass: groove.bassVoicing, chord: groove.chordVoicing },
  };

  const chordNotes = voiceChords(events, voicingOpts);

  const notes = [
    ...score.notes.filter(
      (n) => n.track !== CHORD_TRACK && n.track !== CHORD_BASS_TRACK,
    ),
    ...chordNotes,
  ];

  // Ensure a TrackMeta for both synthesized tracks, preserving any existing
  // metadata and the original track order (new entries appended).
  const byId = new Map(score.tracks.map((t) => [t.id, t]));
  if (!byId.has(CHORD_TRACK))
    byId.set(CHORD_TRACK, { id: CHORD_TRACK, name: "Chords" });
  if (!byId.has(CHORD_BASS_TRACK))
    byId.set(CHORD_BASS_TRACK, { id: CHORD_BASS_TRACK, name: "Bass" });
  const tracks = [...byId.values()];

  const annotations = retargetVoiced(
    score.annotations,
    new Set<Annotation>(selected),
    chordNotes,
  );

  return { ...score, tracks, notes, annotations };
}
