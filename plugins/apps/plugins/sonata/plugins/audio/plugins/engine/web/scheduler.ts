import {
  cycleStart,
  resolvePedalSustain,
  type Note,
  type PlaybackTimeline,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { TimelineStore } from "@plugins/apps/plugins/sonata/plugins/session/web";
import type { InstrumentVoices } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";

/** A running scheduler; `cancel()` stops it following the timeline. */
export interface ScheduleHandle {
  cancel(): void;
}

/**
 * A note that would sound more than this late (it is due in the past by more)
 * is dropped instead of played: after a restart that waited for instruments to
 * load, or a medium's jump, the notes skipped over must not burst out at once.
 * A few tens of ms late still plays.
 */
export const LATE_DROP_SEC = 0.08;

// Keep the look-ahead SHORT. smplr commits a note to the audio graph the instant
// we hand it over (its own look-ahead is 200ms, far wider than ours), locked at the
// tempo in force then — a later timeline change can't reach a committed note. So
// THIS window IS the lag the audio trails the wheel by while scrubbing: a wide
// window reads as the song dragging behind / "slowing down" on acceleration. We
// keep it near the perceptual floor (~40ms) so tracking feels tight. A timeline
// change also pumps immediately (see below), so an in-flight refill never adds
// extra lag. The trade-off is jank tolerance: this is the buffer that absorbs a
// main-thread stall before a note hands over late, so don't drop it to ~0. (A
// lower floor would need a synth-level rework: a custom small smplr scheduler +
// per-note cancel/reschedule of not-yet-sounded notes.)
const LOOKAHEAD_SEC = 0.04; // schedule this far ahead of the audio clock
const REFILL_SEC = 0.02; // idle-heartbeat refill cadence (a change pumps on demand)

/** One scheduled note event, in the look-ahead pump's dispatch form. */
interface SchedEvent {
  track: string;
  pitch: number;
  velocity: number;
  /** The note's path coordinate on the timeline — its identity under a tempo change. */
  c: number;
  /** Source note, retained so a buffered peek can be re-timed. */
  note: Note;
  when: number; // absolute AudioContext time (seconds)
  duration: number; // seconds
}

/**
 * Bounded, timer-free playback scheduler that FOLLOWS the session's timeline:
 * it never keeps an anchor of its own. Every note is placed at
 * `timeline.timeAt(c)` — the same mapping the visual cursor reads — so the
 * sound cannot drift from the cursor.
 *
 * It walks the timeline's path (the head `[origin, B)`, then the loop cycle's
 * `[A − rest, B)` iteration after iteration — a loop wraps with no teardown)
 * through a lazy generator, and hands out only the notes inside a short
 * look-ahead window. A repeat's rest is silent: only the body's notes `[A, B)`
 * sound in it, unless `restSounds` (the metronome, whose clicks keep counting
 * through the rest as a one-bar count-in to every repeat). It re-arms itself via the `onended` of a silent
 * ConstantSourceNode — the audio clock drives every wake-up, so work per pump
 * stays bounded by tempo (never by Score size) and scheduling keeps running
 * even when the tab is backgrounded (unlike rAF). No setInterval / polling.
 *
 * On a timeline change it either:
 *  - **re-times** (same `generation`: tempo, drift correction, clock swap) —
 *    notes already handed to an instrument keep their committed time and are
 *    never cut (cutting them ~60×/s while dragging the speed wheel is a buzz);
 *    generation resumes from the same place, so nothing is double-triggered;
 *  - **restarts** (new `generation`: play, seek, loop edit, a medium's jump) —
 *    silences what is ringing and walks the new path from its start;
 *  - **idles** (`idle`) — silences and arms nothing.
 *
 * Routing is per-track: each note carries its `track`, and `resolveVoices(track)`
 * returns that track's voice manager. A track whose manager isn't (yet)
 * registered is skipped; resolution upstream always yields a registered id, so
 * this only guards transient gaps.
 */
export function startScheduling(
  source: Pick<Score, "notes" | "pedalEvents">,
  timelines: TimelineStore,
  resolveVoices: (trackId: string) => InstrumentVoices | undefined,
  ctx: AudioContext,
  opts: { restSounds?: boolean } = {},
): ScheduleHandle {
  const byStart = (a: Note, b: Note): number => a.start - b.start;
  const sorted = [...source.notes].sort(byStart);
  const tracks = [...new Set(sorted.map((n) => n.track))];

  // Sustain-pedal resolution is in BEATS, hence tempo-invariant — computed
  // ONCE. A note released under a held pedal rings to the pedal lift whatever
  // the tempo. Notes absent from the map sound for their natural length.
  const sustainOff = resolvePedalSustain(source.notes, source.pedalEvents);

  let timeline: PlaybackTimeline | null = null;
  let generation = -1;

  const durationSec = (tl: PlaybackTimeline, n: Note): number => {
    const off = sustainOff.get(n) ?? n.start + n.duration;
    return tl.tempo.beatToSeconds(off) - tl.tempo.beatToSeconds(n.start);
  };

  // --- Lazy event generator over the timeline's path. -----------------------
  // Holds only indices, so memory is O(1) regardless of how long a loop runs.
  let headNotes: Note[] = [];
  let loopNotes: Note[] = [];
  let phase: "head" | "loop" | "done" = "done";
  let hi = 0; // index within headNotes
  let iter = 1; // current loop iteration (1-based)
  let li = 0; // index within loopNotes for the current iteration

  const walk = (tl: PlaybackTimeline): void => {
    const { origin, repeat, cycle } = tl.path;
    // The first beat whose notes sound in a repeat: A, or the rest's start
    // when the rest sounds.
    const soundFrom = cycle
      ? opts.restSounds
        ? cycleStart(cycle)
        : cycle.start
      : -Infinity;
    // A note whose onset is already behind the start (one still sounding when
    // you paused mid-note) must NOT be re-triggered — re-attacking it would
    // replay the previous note. A head that is itself a repeat (resumed inside
    // a rest) sounds nothing of the rest either.
    const headFrom = repeat ? Math.max(origin, soundFrom) : origin;
    headNotes = sorted.filter(
      (n) => n.start >= headFrom && (!cycle || n.start < cycle.end),
    );
    loopNotes = cycle
      ? sorted.filter((n) => n.start >= soundFrom && n.start < cycle.end)
      : [];
    phase =
      headNotes.length > 0 ? "head" : loopNotes.length > 0 ? "loop" : "done";
    hi = 0;
    iter = 1;
    li = 0;
  };

  const buildEvent = (
    tl: PlaybackTimeline,
    n: Note,
    c: number,
  ): SchedEvent => ({
    track: n.track,
    pitch: n.pitch,
    velocity: n.velocity,
    c,
    note: n,
    when: tl.timeAt(c),
    duration: durationSec(tl, n),
  });

  const nextEvent = (tl: PlaybackTimeline): SchedEvent | null => {
    if (phase === "head") {
      if (hi < headNotes.length) {
        const n = headNotes[hi++]!;
        return buildEvent(tl, n, n.start - tl.path.origin);
      }
      if (loopNotes.length === 0) {
        phase = "done";
        return null;
      }
      phase = "loop";
    }
    if (phase === "loop") {
      if (li >= loopNotes.length) {
        iter++;
        li = 0;
      }
      const n = loopNotes[li++]!;
      return buildEvent(tl, n, tl.loopC(iter, n.start));
    }
    return null;
  };

  // One-event look-ahead buffer: the generator is pull-based, so we must peek the
  // next event to test it against the horizon before committing it.
  let peeked: SchedEvent | null = null;
  let ticker: ConstantSourceNode | null = null;
  let cancelled = false;

  // Tear down the pending wake-up node, if any. Lets `pump` run re-entrantly:
  // a timeline change calls it on demand without leaking a second ticker (which
  // would double the pump rate).
  const clearTicker = (): void => {
    if (!ticker) return;
    ticker.onended = null;
    ticker.stop(); // safe: always started; a redundant stop() is a no-op per spec
    ticker.disconnect();
    ticker = null;
  };

  const silence = (): void => {
    for (const track of tracks) resolveVoices(track)?.allOff();
  };

  const pump = (): void => {
    clearTicker(); // we're pumping now; drop any armed wake so we never run twice
    const tl = timeline;
    if (cancelled || !tl) return;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD_SEC;
    for (;;) {
      if (!peeked) peeked = nextEvent(tl);
      if (!peeked || peeked.when > horizon) break;
      if (peeked.when >= now - LATE_DROP_SEC) {
        resolveVoices(peeked.track)?.schedule(peeked);
      }
      peeked = null;
    }
    // No more events ever (linear playback ended, or a silent loop window): arm
    // no further wake-ups. A non-empty loop generates forever, so the heartbeat
    // keeps running until the timeline changes or `cancel`.
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

  // Follow the timeline: restart on a new path, re-time on the same one, and
  // dispatch right away — on acceleration a re-timing pulls upcoming notes
  // EARLIER, and waiting up to REFILL_SEC for the next wake would land them late.
  const follow = (): void => {
    const state = timelines.get();
    if (state.kind === "idle") {
      if (timeline !== null) silence();
      timeline = null;
      generation = -1;
      peeked = null;
      clearTicker();
      return;
    }
    if (state.generation !== generation) {
      if (timeline !== null) silence();
      generation = state.generation;
      timeline = state.timeline;
      peeked = null;
      walk(timeline);
    } else {
      timeline = state.timeline;
      if (peeked) {
        peeked.when = timeline.timeAt(peeked.c);
        peeked.duration = durationSec(timeline, peeked.note);
      }
    }
    pump();
  };

  const unsubscribe = timelines.subscribe(follow);
  follow();

  return {
    cancel(): void {
      cancelled = true;
      unsubscribe();
      clearTicker();
    },
  };
}
