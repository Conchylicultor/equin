/**
 * `@plugins/apps/plugins/sonata/plugins/score/core` — the Sonata narrow waist.
 *
 * Pure, framework-free barrel. Re-exports the `Score` IR types, the
 * display-agnostic rich-display contracts (`Capability`, `Projection`), and the
 * pure time/merge helpers. This sub-plugin has ONLY a `core` runtime and depends
 * on nothing — it is the leaf of the Sonata DAG.
 */

export type {
  Score,
  ScoreRecording,
  Note,
  Annotation,
  ChordAnnotation,
  VoicingAnnotation,
  SectionAnnotation,
  TempoEvent,
  TimeSigEvent,
  PedalEvent,
  TrackMeta,
  KeySignature,
  PitchSpelling,
  LyricAnnotation,
  ChordData,
  VoicingData,
  SectionData,
  LyricData,
  LyricChord,
  Capability,
  Projection,
  AxisTimeline,
  LoopCycle,
  PlayPosition,
} from "./types";

export {
  emptyScore,
  scoreEndBeat,
  scoreStartBeat,
  leadInBeats,
  beatToSeconds,
  bpmAtBeat,
  scaleTempo,
  bars,
  beatGrid,
  prevLine,
  nextLine,
  currentLine,
  subdivideBars,
  mergeScores,
  mergeAnnotations,
} from "./helpers";

export { barStartBeat, barPositionAt, type BarPosition } from "./bar-position";

export type {
  PitchLayoutId,
  PitchKey,
  PitchColumn,
  PitchGuide,
  PitchPlane,
} from "./pitch-plane";
export { markLaidOut } from "./pitch-plane";

export type { TempoIndex } from "./tempo-index";
export { buildTempoIndex } from "./tempo-index";

export { resolvePedalSustain, pedalSpans, isPedalDownAt } from "./pedal";
export type { PedalSpan } from "./pedal";

export type { PlaybackPath, PlaybackTimeline } from "./timeline";
export {
  rebaseTimeline,
  resyncTimeline,
  retempoTimeline,
  startTimeline,
} from "./timeline";

export {
  songPosition,
  samePosition,
  cycleStart,
  barBeatsAt,
} from "./loop-cycle";

export type { AxisBar, AxisScore } from "./loop-timeline";
export { songAxis, unrollLoop } from "./loop-timeline";

export type { ActiveNoteIndex } from "./active-note-index";
export { buildActiveNoteIndex } from "./active-note-index";

export {
  makeKeySpeller,
  accidentalGlyph,
  isAccidental,
  spellScore,
  tonicFifths,
  fifthsToTonic,
} from "./spelling";
export type { KeySpeller } from "./spelling";

export {
  effectiveKeyAt,
  collectKeyEntries,
  songKey,
  asKeySignature,
} from "./key-context";
export type { KeyEntry } from "./key-context";

export { chordBars } from "./chord-bars";
export type { ChordBar, ChordBarSegment } from "./chord-bars";
