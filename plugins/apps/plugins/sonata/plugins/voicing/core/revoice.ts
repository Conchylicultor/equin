/**
 * The single chord-note generation chokepoint.
 *
 * Symbol-based sources (chord-grid, Ultimate Guitar, …) emit chord
 * *annotations* only; this step regenerates the chord *notes* from those
 * annotations under the global voicing config. Run reactively in the shell
 * (before key inference, so chord notes exist for detection), it makes
 * voice-leading an orthogonal modifier applied uniformly to every symbol source
 * — zero per-source code. The shell runs it a second time, after analysis, with
 * `include: "all"` when a song's chord mode is on — so a MIDI song's DETECTED
 * chords become playable notes through the very same voicing + groove.
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
 * Resolve one rhythm pattern to absolute onset beats on the score's bar grid.
 *
 * The necklace repeats every bar: within each bar an effective onset `k` lands at
 * `barStart + span·k/subdivisions`, where `span` is that bar's length. Bars are
 * enumerated with `bars()` (time-signature aware, 4/4 by default — what the chord
 * grid emits), and the final bar's span runs to `scoreEndBeat`. We iterate bars
 * explicitly rather than via `subdivideBars(score, n)`, which collapses a
 * degenerate `span <= 0` bar to a single entry and would desynchronise the grid.
 * Because onsets are sorted and every in-bar beat is `< nextBarStart`, the
 * concatenation across bars is already sorted ascending.
 */
function resolvePattern(score: Score, pattern: RhythmPattern): number[] {
  const barList = bars(score);
  const end = scoreEndBeat(score);
  const onsets = effectiveOnsets(pattern);
  const beats: number[] = [];
  for (let i = 0; i < barList.length; i++) {
    const start = barList[i]!.startBeat;
    const next = i + 1 < barList.length ? barList[i + 1]!.startBeat : end;
    const span = next - start;
    if (span <= 0) continue; // skip a degenerate (zero/negative-length) bar
    for (const k of onsets) {
      beats.push(start + (span * k) / pattern.subdivisions);
    }
  }
  return beats;
}

/**
 * Regenerate chord notes from a score's chord annotations under `cfg`,
 * returning a new `Score`. Which annotations count is `opts.include` (default:
 * authored only — see {@link ReVoiceInclude}). All other tracks, notes, and
 * annotations are kept intact; only notes on {@link CHORD_TRACK} /
 * {@link CHORD_BASS_TRACK} are replaced (so a second pass replaces, never
 * duplicates), a `TrackMeta` for each is ensured, and every voiced chord
 * annotation is re-targeted at the notes generated for it. When the score has
 * no selected chord annotations the input is returned unchanged.
 *
 * When `groove` is nullish the emitted notes are byte-for-byte today's block
 * chords (no `rhythm`/`figuration` reaches the engine). When present, each hand's
 * pattern is resolved to absolute onset beats on the bar grid (`opts.rhythm`) and
 * its figuration id resolved to a {@link Figuration} (`opts.figuration`), so each
 * hand strikes its own bar-anchored, tone-ordered groove instead of one block
 * note per chord. With a groove, each hand's register, voice-leading, octave
 * doubling and on/off are its own (`bassVoicing` / `chordVoicing`); `cfg` then
 * voices only the no-groove block path.
 */
export function reVoiceChords(
  score: Score,
  cfg: { realistic: boolean; octave: number },
  groove?: {
    hands: RhythmHands;
    bassFigurationId: string;
    chordFigurationId: string;
    bassVoicing: HandVoicing;
    chordVoicing: HandVoicing;
  } | null,
  opts?: ReVoiceOptions,
): Score {
  const selected = score.annotations.filter(
    chordSelector(opts?.include ?? "authored"),
  );
  const events: ChordEvent[] = selected
    .map((a) => ({ data: a.data, start: a.start, end: a.end }))
    .sort((x, y) => x.start - y.start);

  if (events.length === 0) return score;

  const voicingOpts: VoicingOptions = {
    octave: cfg.octave,
    voiceLead: cfg.realistic,
    track: CHORD_TRACK,
    bassTrack: CHORD_BASS_TRACK,
    idPrefix: CHORD_NOTE_PREFIX,
  };
  if (groove) {
    voicingOpts.rhythm = {
      bass: resolvePattern(score, groove.hands.bass),
      chord: resolvePattern(score, groove.hands.chord),
    };
    voicingOpts.figuration = {
      bass: findFiguration(groove.bassFigurationId),
      chord: findFiguration(groove.chordFigurationId),
    };
    voicingOpts.hands = {
      bass: groove.bassVoicing,
      chord: groove.chordVoicing,
    };
  }

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
