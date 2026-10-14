import {
  bars,
  beatGrid,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  ACCENT_PITCH,
  CLICK_DURATION_BEATS,
  METRONOME_TRACK,
  NORMAL_PITCH,
  SUB_PITCH,
} from "./constants";

// Bar-start beats and grid-cell beats are both accumulated from 0 by the same
// pure derivation, so an exact-match Set keyed on a rounded beat is reliable for
// the meters Sonata handles. The rounding (sub-millibeat, matching the score
// helpers' own LINE_EPS scale) guards against float drift in odd meters.
const roundBeat = (beat: number): number => Math.round(beat * 1000) / 1000;

/**
 * Build the synthetic click track for the continuous metronome, one tiny note
 * per grid cell of `beatGrid(score, subdivision)`. Each click carries one of
 * three accent tiers via its `pitch` sentinel:
 *
 *  - {@link ACCENT_PITCH} — a bar downbeat (only when `accentDownbeat`).
 *  - {@link NORMAL_PITCH} — a main (notated) beat that is not a downbeat.
 *  - {@link SUB_PITCH}    — an in-between subdivision cell (present only when
 *                           `subdivision > 1`), sounded as a lighter, quieter tick.
 *
 * The song's meter always wins: main-beat positions are `beatGrid(score, 1)` and
 * downbeats are `bars(score)`, so the subdivision only *inserts* finer clicks
 * between the notated beats — it never shifts or overrides the pulse.
 *
 * PURE and tempo-INVARIANT: it reads only beat positions (`bars` / `beatGrid`),
 * which `scaleTempo` never touches — so a tempo drag leaves this list unchanged
 * and the scheduler re-times the clicks off the timeline without rebuilding them.
 */
export function buildClickNotes(
  score: Score,
  accentDownbeat: boolean,
  subdivision = 1,
): Note[] {
  const div = subdivision >= 1 ? Math.floor(subdivision) : 1;
  const grid = beatGrid(score, div);
  // O(1) tier lookups: the set of bar-start beats and of main (notated) beats.
  const downbeats = new Set(bars(score).map((b) => roundBeat(b.startBeat)));
  const mainBeats = new Set(
    beatGrid(score, 1).map((cell) => roundBeat(cell.startBeat)),
  );

  return grid.map((cell, i) => {
    const beat = roundBeat(cell.startBeat);
    const pitch =
      accentDownbeat && downbeats.has(beat)
        ? ACCENT_PITCH
        : mainBeats.has(beat)
          ? NORMAL_PITCH
          : SUB_PITCH;
    return {
      id: `${METRONOME_TRACK}:${i}`,
      pitch,
      start: cell.startBeat,
      duration: CLICK_DURATION_BEATS,
      velocity: 100,
      track: METRONOME_TRACK,
    };
  });
}
