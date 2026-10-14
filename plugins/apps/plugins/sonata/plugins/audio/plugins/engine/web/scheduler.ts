import {
  buildTempoIndex,
  cycleStart,
  resolvePedalSustain,
  type LoopCycle,
  type Note,
  type PlayPosition,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { InstrumentVoices } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";

/**
 * Where a schedule starts: the play position's score `beat` and, inside an
 * A–B loop's rest, the `rest` still to go before it sounds (the schedule then
 * opens with that much silence).
 */
export type ScheduleFrom = Pick<PlayPosition, "beat" | "rest">;

/** A running playback schedule; `cancel()` tears down the look-ahead loop. */
export interface ScheduleHandle {
  cancel(): void;
  /**
   * Re-time the not-yet-dispatched tail for a new tempo, re-anchored at the
   * current audio-clock position. A tempo-only change (the speed jog-wheel) is a
   * pure re-timing — note beats/identities and the loop structure are preserved —
   * so it calls this instead of cancel + rebuild: notes already handed to the
   * instrument keep their committed time and **are never cut** (that cutting,
   * ~60×/sec while dragging, is the buzz), and generation resumes from the same
   * cursor so nothing is double-triggered. `tempoSource` is used ONLY to rebuild
   * the tempo index; the (already mute-filtered) note set is reused untouched.
   * `newAudioAnchor` is `ctx.currentTime` captured at the change instant.
   */
  retime(tempoSource: Score, newAudioAnchor: number): void;
  /**
   * The beat the schedule is sounding at audio time `audioTime` (an A–B loop's
   * iterations folded back into its cycle; a beat inside a rest reads as the
   * silent beat before A it stands in for). What a drift check
   * compares with an external medium's position.
   */
  beatAt(audioTime: number): number;
  /**
   * Re-anchor so `beat` sounds at audio time `audioTime` — `retime`'s sibling
   * for a POSITION correction at an unchanged tempo (the synth slipped against
   * an external medium driving the transport). Like `retime` it never cuts a
   * note already handed to an instrument and never re-triggers one: generation
   * continues from its own cursor. Notes the jump skipped over that would now
   * sound more than {@link RESYNC_LATE_SEC} late are dropped instead of played
   * in a burst. Inside an A–B loop, `beat` lands in the iteration nearest the
   * current one.
   */
  resync(beat: number, audioTime: number): void;
}

/**
 * After a `resync` forward, a skipped note is still played if it is at most
 * this late (a slip of a few tens of ms keeps its notes), and dropped beyond.
 */
export const RESYNC_LATE_SEC = 0.08;

// Keep the look-ahead SHORT. smplr commits a note to the audio graph the instant
// we hand it over (its own look-ahead is 200ms, far wider than ours), locked at the
// tempo in force then — `retime` can't reach a committed note. So THIS window IS the
// lag the audio trails the wheel by while scrubbing: a wide window reads as the song
// dragging behind / "slowing down" on acceleration. We keep it near the perceptual
// floor (~40ms) so tracking feels tight. `retime` also pumps immediately (see below),
// so an in-flight refill never adds extra lag. The trade-off is jank tolerance: this
// is the buffer that absorbs a main-thread stall before a note hands over late, so
// don't drop it to ~0. (A lower floor would need a synth-level rework: a custom small
// smplr scheduler + per-note cancel/reschedule of not-yet-sounded notes.)
const LOOKAHEAD_SEC = 0.04; // schedule this far ahead of the audio clock
const REFILL_SEC = 0.02; // idle-heartbeat refill cadence (retime pumps on demand)

/** One scheduled note event, in the look-ahead pump's dispatch form. */
interface SchedEvent {
  track: string;
  pitch: number;
  velocity: number;
  /**
   * The note's position on the tempo-invariant **cumulative-beat path** `c`
   * (head beats then loop iterations laid end to end). Identity under tempo
   * changes — `retime` recomputes `when`/`duration` from `c` + `note`, never
   * re-derives `c`.
   */
  c: number;
  /** Source note, retained so a buffered peek can be re-timed on `retime`. */
  note: Note;
  when: number; // absolute AudioContext time (seconds)
  duration: number; // seconds
}

/**
 * Bounded, timer-free playback scheduler. Pulls future notes from a lazy
 * generator (sorted by absolute audio time) and schedules only those inside a
 * short look-ahead window. It re-arms itself via the `onended` of a silent
 * ConstantSourceNode — the audio clock drives every wake-up, so work per pump
 * stays bounded by tempo (never by Score size) and scheduling keeps running even
 * when the tab is backgrounded (unlike rAF). No setInterval / polling.
 *
 * `audioAnchor` is `ctx.currentTime` captured at the play instant; `from` is
 * the cursor's position at that same instant, whose path starts at
 * `o = from.beat − from.rest` (a cursor paused inside a loop's rest resumes
 * with the rest's remaining silence). Notes are placed on a single monotonic
 * **cumulative-beat coordinate** `c`: the first pass runs `[o, loop.end)` (or
 * all remaining notes when not looping) at `c = start − o`, then each loop
 * iteration `k ≥ 1` lays the `LoopCycle`'s `[A − rest, B)` end to end at
 * `c = (B − o) + (k−1)(B − (A − rest)) + (start − (A − rest))` — the rest is
 * real time on the path, timed by the tempo map over the bar it replaces, the
 * same definition the transport's cursor fold reads. Only the body's notes
 * `[A, B)` sound in an iteration (`restSounds` also sounds the notes of the
 * span the rest replaces — the metronome's clicks, which keep counting
 * through it).
 * `when(c)` integrates that path through the tempo index from a single fixed
 * anchor, so **a loop wraps with no teardown** — the generator just keeps
 * emitting the next iteration ahead of the boundary (the fix for the audible
 * gap). With no loop the generator runs out at the last note, exactly as before.
 *
 * Routing is per-track: each note carries its `track`, and `resolveVoices(track)`
 * returns the voice manager for that track's resolved instrument — so tracks with
 * distinct timbres sound simultaneously through their own managers. A track whose
 * manager isn't (yet) registered is skipped; resolution upstream always yields a
 * registered id, so this only guards transient gaps.
 */
export function startScheduling(
  score: Score,
  from: ScheduleFrom,
  audioAnchor: number,
  resolveVoices: (trackId: string) => InstrumentVoices | undefined,
  ctx: AudioContext,
  loop: LoopCycle | null = null,
  opts: { restSounds?: boolean } = {},
): ScheduleHandle {
  let tempo = buildTempoIndex(score);
  // The path origin: the cursor beat less any rest still to go (a rest only
  // exists inside a loop).
  const fromBeat = loop ? from.beat - from.rest : from.beat;
  // An iteration's first beat (the rest's start), and the first beat whose
  // notes sound in it.
  const loopStart = loop ? cycleStart(loop) : 0;
  const soundFrom = loop && !opts.restSounds ? loop.start : loopStart;

  const byStart = (a: Note, b: Note): number => a.start - b.start;
  // First pass: notes at/after the resume cursor. A note whose onset is already
  // behind the cursor (e.g. one still sounding when you paused mid-note) must NOT
  // be re-triggered — re-attacking it would replay the previous note. When
  // looping the first pass ends at `loop.end` (the rest is covered by the loop
  // iterations); a start before `loop.start` still plays straight into the loop.
  // Resuming inside a rest sounds nothing of it (unless `restSounds`).
  const headFrom = opts.restSounds ? fromBeat : from.beat;
  const headNotes = score.notes
    .filter((n) => n.start >= headFrom && (!loop || n.start < loop.end))
    .sort(byStart);
  // The looped segment, replayed every iteration after the first pass.
  const loopNotes = loop
    ? score.notes
        .filter((n) => n.start >= soundFrom && n.start < loop.end)
        .sort(byStart)
    : [];

  const headLenBeats = loop ? loop.end - fromBeat : 0;
  const loopLenBeats = loop ? loop.end - loopStart : 0;

  // when(c) = anchorWhen + pathSec(c) − anchorPathSec. The anchor is fixed for
  // the schedule's life and only moves on `retime` (which re-derives the played
  // path under the new tempo from the live audio clock).
  let anchorWhen = audioAnchor;
  let anchorC = 0;

  // Cumulative seconds along the played path up to coordinate `c`, under the
  // current tempo. Within the head it is a plain beat→seconds span; past it the
  // whole loop iterations contribute their full seconds-length and the partial
  // last iteration its prefix — so a varying tempo inside the loop is exact.
  const pathSec = (c: number): number => {
    if (!loop || c <= headLenBeats) {
      return tempo.beatToSeconds(fromBeat + c) - tempo.beatToSeconds(fromBeat);
    }
    const loopSec =
      tempo.beatToSeconds(loop.end) - tempo.beatToSeconds(loopStart);
    const r = c - headLenBeats;
    const full = Math.floor(r / loopLenBeats);
    const remBeat = r - full * loopLenBeats;
    return (
      tempo.beatToSeconds(loop.end) -
      tempo.beatToSeconds(fromBeat) +
      full * loopSec +
      (tempo.beatToSeconds(loopStart + remBeat) -
        tempo.beatToSeconds(loopStart))
    );
  };

  // Inverse of `pathSec`: the coordinate `c` whose played path is `sec` seconds.
  // Used by `retime` to find the current position under the OLD tempo before
  // re-anchoring under the new one.
  const pathSecInverse = (sec: number): number => {
    const headSec =
      tempo.beatToSeconds(loop ? loop.end : fromBeat) -
      tempo.beatToSeconds(fromBeat);
    if (!loop || sec <= headSec) {
      return (
        tempo.secondsToBeat(tempo.beatToSeconds(fromBeat) + sec) - fromBeat
      );
    }
    const loopSec =
      tempo.beatToSeconds(loop.end) - tempo.beatToSeconds(loopStart);
    const r = sec - headSec;
    const full = Math.floor(r / loopSec);
    const remSec = r - full * loopSec;
    const remBeat =
      tempo.secondsToBeat(tempo.beatToSeconds(loopStart) + remSec) - loopStart;
    return headLenBeats + full * loopLenBeats + remBeat;
  };

  let anchorPathSec = pathSec(anchorC); // 0 at build; recomputed on retime
  const whenFor = (c: number): number =>
    anchorWhen + pathSec(c) - anchorPathSec;
  // The path coordinate sounding at audio time `t` (inverse of `whenFor`).
  const cAt = (t: number): number =>
    pathSecInverse(t - anchorWhen + anchorPathSec);
  // The score beat at path coordinate `c`, loop iterations folded.
  const beatOf = (c: number): number => {
    if (!loop || c <= headLenBeats) return fromBeat + c;
    const r = (c - headLenBeats) % loopLenBeats;
    return loopStart + r;
  };
  // The path coordinate of `beat` nearest `near`: in the head, or in the loop
  // iteration closest to the current one.
  const cOfBeatNear = (beat: number, near: number): number => {
    if (!loop || beat < loopStart || beat >= loop.end) return beat - fromBeat;
    const candidates: number[] = beat >= fromBeat ? [beat - fromBeat] : [];
    const offset = beat - loopStart;
    const k = Math.round((near - headLenBeats - offset) / loopLenBeats) + 1;
    for (const iter of [k - 1, k, k + 1]) {
      if (iter >= 1) {
        candidates.push(headLenBeats + (iter - 1) * loopLenBeats + offset);
      }
    }
    return candidates.reduce((best, c) =>
      Math.abs(c - near) < Math.abs(best - near) ? c : best,
    );
  };
  // Undispatched events due before this audio time are dropped, not played
  // late (set by `resync`; events are in time order, so it bites once).
  let dropBefore = -Infinity;

  // Sustain-pedal resolution is in BEATS, hence tempo-invariant — compute the
  // per-note extended sounding off-beat ONCE. It survives `retime` untouched
  // (which only rebuilds the tempo index; note beats and the pedal lane are
  // preserved), so a note released under a held pedal keeps ringing to the
  // pedal lift regardless of tempo changes. Notes absent from the map sound for
  // their natural `start + duration`.
  const sustainOff = resolvePedalSustain(score.notes, score.pedalEvents);

  const durationSec = (n: Note): number => {
    const off = sustainOff.get(n) ?? n.start + n.duration;
    return tempo.beatToSeconds(off) - tempo.beatToSeconds(n.start);
  };

  const buildEvent = (n: Note, c: number): SchedEvent => ({
    track: n.track,
    pitch: n.pitch,
    velocity: n.velocity,
    c,
    note: n,
    when: whenFor(c),
    duration: durationSec(n),
  });

  // --- Lazy event generator over the cumulative-beat path. ------------------
  // Holds only indices, so memory is O(1) regardless of how long a loop runs.
  let phase: "head" | "loop" | "done" =
    headNotes.length > 0
      ? "head"
      : loop && loopNotes.length > 0
        ? "loop"
        : "done";
  let hi = 0; // index within headNotes
  let iter = 1; // current loop iteration (1-based)
  let li = 0; // index within loopNotes for the current iteration

  const nextEvent = (): SchedEvent | null => {
    if (phase === "head") {
      if (hi < headNotes.length) {
        const n = headNotes[hi++]!;
        return buildEvent(n, n.start - fromBeat);
      }
      if (loop && loopNotes.length > 0) {
        phase = "loop";
        iter = 1;
        li = 0;
      } else {
        phase = "done";
        return null;
      }
    }
    if (phase === "loop" && loop) {
      if (li >= loopNotes.length) {
        iter++;
        li = 0;
      }
      const n = loopNotes[li++]!;
      const c =
        headLenBeats + (iter - 1) * loopLenBeats + (n.start - loopStart);
      return buildEvent(n, c);
    }
    return null;
  };

  // One-event look-ahead buffer: the generator is pull-based, so we must peek the
  // next event to test it against the horizon before committing it.
  let peeked: SchedEvent | null = null;
  let ticker: ConstantSourceNode | null = null;
  let cancelled = false;

  // Tear down the pending wake-up node, if any. Lets `pump` run re-entrantly:
  // `retime` calls it on demand without leaking a second ticker (which would
  // double the pump rate).
  const clearTicker = (): void => {
    if (!ticker) return;
    ticker.onended = null;
    ticker.stop(); // safe: always started; a redundant stop() is a no-op per spec
    ticker.disconnect();
    ticker = null;
  };

  const pump = (): void => {
    if (cancelled) return;
    clearTicker(); // we're pumping now; drop any armed wake so we never run twice
    const horizon = ctx.currentTime + LOOKAHEAD_SEC;
    for (;;) {
      if (!peeked) peeked = nextEvent();
      if (!peeked || peeked.when > horizon) break;
      if (peeked.when >= dropBefore)
        resolveVoices(peeked.track)?.schedule(peeked);
      peeked = null;
    }
    // No more events ever (linear playback ended, or a silent loop window): arm
    // no further wake-ups. A non-empty loop generates forever, so the heartbeat
    // keeps running until `cancel` — the same ~REFILL_SEC cadence as playback.
    if (!peeked) return;

    // Wake again on the audio clock (no JS timer) to refill the window. A
    // ConstantSourceNode with offset 0 is silent; its `onended` fires at `stop`.
    const node = new ConstantSourceNode(ctx, { offset: 0 });
    node.connect(ctx.destination);
    node.onended = () => {
      node.disconnect();
      if (ticker === node) ticker = null;
      pump();
    };
    node.start();
    node.stop(ctx.currentTime + REFILL_SEC);
    ticker = node;
  };

  pump();

  return {
    cancel(): void {
      cancelled = true;
      clearTicker();
    },
    retime(tempoSource: Score, newAudioAnchor: number): void {
      if (cancelled) return;
      // Where are we on the path right now, under the OLD tempo? `when(cNow)` is
      // exactly `ctx.currentTime`, so pathSec(cNow) = now − anchorWhen +
      // anchorPathSec; invert to the cumulative coordinate.
      const cNow = pathSecInverse(newAudioAnchor - anchorWhen + anchorPathSec);
      // Switch tempo, then re-anchor so the current position keeps sounding at
      // `now` and everything ahead is re-derived under the new tempo. Notes
      // already handed to the instrument keep their committed time and are never
      // cut (the buzz). Generation continues from its own cursor, which is past
      // `cNow`, so nothing is double-triggered.
      tempo = buildTempoIndex(tempoSource);
      anchorWhen = newAudioAnchor;
      anchorC = cNow;
      anchorPathSec = pathSec(anchorC);
      // The buffered peek was timed under the old anchor — re-derive it.
      if (peeked) {
        peeked.when = whenFor(peeked.c);
        peeked.duration = durationSec(peeked.note);
      }
      // Dispatch right away: on acceleration the rescale pulls upcoming notes
      // EARLIER, and waiting up to REFILL_SEC for the next wake would land them
      // late — extra lag that reads as the song dragging behind the wheel. `pump`
      // clears the armed ticker first, so calling it here never double-schedules.
      pump();
    },
    beatAt(audioTime: number): number {
      return beatOf(cAt(audioTime));
    },
    resync(beat: number, audioTime: number): void {
      if (cancelled) return;
      const cNew = cOfBeatNear(beat, cAt(audioTime));
      anchorWhen = audioTime;
      anchorC = cNew;
      anchorPathSec = pathSec(anchorC);
      dropBefore = audioTime - RESYNC_LATE_SEC;
      if (peeked) peeked.when = whenFor(peeked.c);
      pump();
    },
  };
}
