import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  barBeatsAt,
  buildTempoIndex,
  createHeardTimeline,
  currentLine,
  emptyScore,
  nextLine,
  prevLine,
  rebaseTimeline,
  resyncTimeline,
  retempoTimeline,
  scaleTempo,
  scoreEndBeat,
  scoreStartBeat,
  songPosition,
  startTimeline,
  subdivideBars,
  type LoopCycle,
  type PlaybackPath,
  type PlaybackTimeline,
  type PlayPosition,
  type Score,
  type TimelineTakeover,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useCursorApi } from "./cursor-store";
import { SonataSession } from "./slots";
import { createTimelineStore, type TimelineStore } from "./timeline-store";

/** Tempo scale clamp — slowest 0× (frozen / 0%) to fastest 4× (quadruple). */
const MIN_TEMPO_SCALE = 0;
const MAX_TEMPO_SCALE = 4;

/**
 * The smallest tempo factor the beat↔seconds math ever sees. At a literal 0×
 * the tempo map collapses to 0 bpm — infinite seconds per beat — which makes
 * `beatToSeconds` non-finite and propagates `NaN` through the transport, the
 * audio scheduler, and the piano-roll geometry (which multiplies seconds by the
 * scale, so `Infinity × 0 = NaN`). 0% is instead modeled as a *frozen* transport
 * (playback is paused; see `play`/the freeze effect below), so the cursor never
 * advances and this floor is never observable — it exists purely to keep the
 * tempo map finite. It fully cancels in the piano-roll geometry, so the exact
 * value doesn't affect layout.
 */
export const TEMPO_MATH_FLOOR = 0.05;

/**
 * Smallest gap (in beats) between a loop's `start` and `end`, enforced in
 * `setLoop` so the two handles can never cross or collapse to a degenerate
 * zero-length range (which would make the rAF wrap thrash). Sibling of
 * `TEMPO_MATH_FLOOR`: a tiny structural floor that keeps the transport math
 * well-behaved.
 */
const LOOP_MIN_GAP = 1;

/**
 * How finely the seek grid subdivides a bar at a given playback tempo: a whole
 * bar at authored tempo or faster, then halving each time the tempo halves
 * (half-bar at ≤50%, quarter-bar at ≤25%, eighth-bar at ≤12.5%, …). The
 * invariant is that one tap rewinds a roughly *constant wall-clock duration* —
 * about one bar at authored tempo — so slowing down to practice a dense passage
 * automatically buys finer-grained seeking, with no tuned threshold. Floored at
 * `TEMPO_MATH_FLOOR` so a frozen 0% can't diverge to an unbounded subdivision.
 */
function seekSubdivisions(tempoScale: number): number {
  const scale = Math.max(tempoScale, TEMPO_MATH_FLOOR);
  if (scale >= 1) return 1;
  return 2 ** Math.floor(Math.log2(1 / scale));
}

/**
 * A monotonic time source in seconds. The default is the wall clock
 * (`performance.now`); the audio engine registers an `AudioContext.currentTime`
 * clock so the visual cursor reads the *same* clock the audio is scheduled
 * against — eliminating drift and keeping the playhead correct across tab
 * backgrounding.
 *
 * `now()` is when a sample is RENDERED; it is heard `latency()` later (the
 * output device's buffering — tens of ms on built-in speakers, hundreds on
 * Bluetooth). Schedulers place notes on `now()`; what the user sees follows
 * what they hear, at `now() − latency()`.
 */
export interface TransportClock {
  /** Current time in seconds (same units/origin the audio scheduler uses). */
  now(): number;
  /**
   * `now()` for drawing a frame: continuous from one frame to the next, within
   * a buffer of `now()`. A source that advances in steps (an AudioContext's
   * `currentTime`, once per rendered buffer) smooths it here — read raw, frames
   * land 0 or 2 steps apart and every playhead moves in jerks. Only the cursor
   * reads it; schedulers place sound on the exact `now()`.
   */
  drawNow(): number;
  /** Seconds from rendering a sample at `now()` to hearing it (≥ 0). Read every frame: it changes with the output device. */
  latency(): number;
}

/**
 * What an external transport driver is doing, pushed through
 * {@link TransportDriver.subscribe}.
 *
 *  - `advancing`: the medium plays; `position()` answers.
 *  - `stalled`: it wants to play but is not advancing (buffering, seeking).
 *  - `paused`: it is not playing (paused, cued, ended) — by the session's
 *    request or on its own.
 *  - `failed`: it cannot play at all.
 */
export type DriverState =
  | { kind: "advancing" }
  | { kind: "stalled" }
  | { kind: "paused" }
  | { kind: "failed"; reason: string };

/**
 * An external medium that OWNS the playback position — a recording the score
 * is timed against (`Score.meta.recording`). Where a {@link TransportClock}
 * only answers "what time is it", a medium seeks, buffers, pauses on its own
 * and takes only the rates it supports, so while one is registered the session
 * follows it instead of its anchored clock: the cursor is read from
 * `position()`, play / pause / seek / tempo are forwarded to it, and an
 * external pause stops the transport.
 *
 * Times are MEDIA seconds — score seconds at tempo scale 1 — so a driver never
 * has to know the tempo scale: the session converts through the unscaled tempo
 * map, and a rate the driver took becomes the tempo scale.
 */
export interface TransportDriver {
  /** Media seconds while advancing; `null` while not (buffering, seeking, paused). */
  position(): number | null;
  play(): void;
  pause(): void;
  /** Move to `mediaSec` (never negative). Does not start or stop playback. */
  seek(mediaSec: number): void;
  /** Ask for a playback rate; resolves to the rate the medium actually took. */
  setRate(rate: number): Promise<number>;
  /**
   * Listen to the driver's state. The listener is called once with the
   * current state on subscribe, then on every change.
   */
  subscribe(listener: (state: DriverState) => void): () => void;
}

/**
 * Where the transport stands relative to the driver, right now:
 *  - `internal`: no driver — the timeline on the session's clock is the truth.
 *  - `stalled`: a driver is registered but not advancing — nothing sounds.
 *  - `advancing`: the driver's medium is at `beat`, now.
 */
type DriverReading =
  | { kind: "internal" }
  | { kind: "stalled" }
  | { kind: "advancing"; beat: number };

/**
 * How far (seconds) the cursor may sit from where a driver is known to be
 * before resuming playback seeks the driver to the cursor. Below it the two
 * agree and a seek (a visible YouTube re-buffer) is not worth it.
 */
const DRIVER_ALIGN_TOLERANCE_SEC = 0.05;

/**
 * How far (seconds, at the playing tempo) the timeline may slip from a driving
 * medium before it is re-anchored on it. Below it a slip is inaudible against
 * a recording; above it a drum hit and a synth note stop sounding like one
 * event. The cursor shows the medium's own position; the timeline is what the
 * synth sounds, so this is the only gap between the two, bounded.
 */
const DRIFT_TOLERANCE_SEC = 0.04;

/**
 * An A–B practice loop range, in beats. `enabled` gates whether the transport
 * actually wraps at `end`; a defined-but-disabled loop stays visible (faded) so
 * the user can keep the markers while playing straight through.
 */
export interface LoopRange {
  start: number;
  end: number;
  enabled: boolean;
}

/**
 * How an enabled A–B loop repeats — the user's preferences, not part of any
 * one loop (a loop UI pushes them in; a bare session plays neither).
 *
 *  - `rest`: rest one bar (at A's meter) before every repeat, so the next pass
 *    can be seen coming. Real time: the playback timeline walks it, so the
 *    cursor, the audio and the metronome all run it (see
 *    {@link SessionValue.loopCycle}).
 *  - `ahead`: a display drawing what comes next shows the loop repeating past
 *    B instead of the song's continuation (see `unrollLoop`). Display-only.
 */
export interface LoopOptions {
  rest: boolean;
  ahead: boolean;
}

/** A bare session's loop options: a seamless wrap, the song drawn as written. */
const NO_LOOP_OPTIONS: LoopOptions = { rest: false, ahead: false };

/**
 * A pending count-in (metronome lead-in) before playback begins. While this is
 * set, `isPlaying` stays false — so the transport rAF doesn't run and the cursor
 * **parks at `startBeat` naturally** (no anchor/tick changes needed) — and the
 * metronome plugin clicks out `beats` beats over `durationSec` against the audio
 * clock, then calls `finishCountIn()` to begin real playback from `startBeat`.
 * `null` when no count-in is in progress.
 */
export interface CountInState {
  /** Beat playback will start from once the lead-in completes. */
  startBeat: number;
  /** Lead-in length in quarter-note beats (what the provider returned). */
  beats: number;
  /** Transport-clock time the lead-in started (audio-clock seconds). */
  startedAtClockSec: number;
  /** Lead-in duration in seconds at the start-beat tempo. */
  durationSec: number;
}

/**
 * What a session plays: the song document's content, as the session needs it.
 * Every arm carries `contentKey` — the identity of the loaded TIMELINE (the
 * compiled, merged sources, before any view transform). It moves only when
 * real content is loaded or edited, never when a view transform (transpose,
 * voicing, key detection) re-derives `score` over the same timeline. The
 * transport resets on a `contentKey` change, so a transform applies live
 * without rewinding playback.
 *
 *  - `empty`: nothing loaded — an empty score is the truth.
 *  - `pending`: content is loaded but not composable yet (its per-song
 *    settings are loading). The transport stops at once; the rewind (and any
 *    play/seek-on-load) waits for it to compose.
 *  - `failed`: content is loaded but could not be composed (a setting's read
 *    failed). Plays nothing, like `empty`.
 *  - `ready`: the composed score.
 *
 * Structural so the session imports no document plugin: a document's own
 * content union is assignable to this.
 */
export type SessionContent =
  | { kind: "empty" | "pending" | "failed"; contentKey: object }
  | { kind: "ready"; contentKey: object; score: Score };

export interface SessionValue {
  /**
   * The score being played (empty unless the content is `ready`), with the
   * current `tempoScale` already folded into its tempo map — so displays,
   * audio, and the transport cursor all share one consistent timeline.
   */
  score: Score;
  /**
   * The seekable span `[startBeat, endBeat]` of {@link score}, in beats — THE
   * bound every navigation surface shares. `startBeat` is the timeline origin
   * (the one-bar lead-in pre-roll at NEGATIVE beats for a non-empty score; see
   * `scoreStartBeat`), NOT the first note at beat 0.
   *
   * Exposed because the transport is the only owner of this invariant:
   * `seekTo` already clamps to it, so a consumer driving `seekTo` must NOT
   * re-derive its own bound — that is exactly how the piano roll's wheel/drag
   * gestures once floored on beat 0 while the keyboard rewind reached the
   * lead-in. Read this when a gesture genuinely needs the span itself (e.g. a
   * drag's rubber-band physics); otherwise just call `seekTo` and let it clamp.
   */
  timelineBeats: readonly [start: number, end: number];
  isPlaying: boolean;
  /** Playback tempo multiplier (1 = authored tempo). */
  tempoScale: number;
  /**
   * The playback timeline — THE mapping from the active clock to the music
   * while something sounds (see `TimelineState`). Every audio scheduler places
   * its notes at `timeline.timeAt(c)` (render time), and the cursor shows the
   * same mapping at the instant now being HEARD — `now − latency`, on the
   * timeline that was in force then — so sound and cursor share one mapping
   * and cannot drift apart. Stable; read it imperatively and
   * `subscribe` to follow it (it changes every frame of a speed-wheel drag).
   */
  timeline: TimelineStore;
  /** Whether a {@link TransportDriver} is registered (it then owns the position). */
  driven: boolean;
  /**
   * The active clock's instant now being heard: `now() − latency()`. A visual
   * timed against the clock (the count-in countdown) reads this, so it changes
   * when its sound reaches the ears, not when it is rendered.
   */
  heardNow: () => number;
  /**
   * The active A–B practice loop range (beats), or `null` when no region is
   * set. When `loop.enabled`, the transport rAF wraps from `loop.end` back to
   * `loop.start` instead of running to the song end. A defined-but-disabled
   * loop stays in state (the marker shows it faded) so the bounds survive a
   * play-through.
   */
  loop: LoopRange | null;
  /**
   * The loop as playback cycles it — THE definition every consumer of "what
   * plays after B" reads (the playback timeline the cursor and the audio
   * schedulers follow, a display unrolling the loop): `null` unless a loop is
   * enabled, else its bounds plus the rest before each repeat. The rest is one
   * bar at A's meter when {@link loopOptions}`.rest` is on — and `0` while a
   * {@link TransportDriver} drives: a medium cannot fold a loop, so its wrap
   * stays a seek back to A and a rest would only freeze the picture against a
   * recording that keeps playing. Identity-stable while its values hold (a
   * tempo change does not mint a new one), so an effect may depend on it.
   */
  loopCycle: LoopCycle | null;
  /** The loop's repeat options (see {@link LoopOptions}). */
  loopOptions: LoopOptions;
  /**
   * A pending count-in (metronome lead-in), or null. While set, playback has not
   * yet started: the cursor parks at `startBeat` and the metronome clicks out the
   * lead-in. The metronome reads this to schedule its clicks + drive the on-screen
   * countdown; consumers should treat a non-null `countIn` as "about to play".
   */
  countIn: CountInState | null;

  /**
   * Toggle play/pause from the current cursor. Stable; the controls plugin
   * registers it as a per-surface, focus-scoped Space shortcut on every shown
   * player, so each Sonata window or preview toggles only its own transport.
   */
  togglePlay: () => void;
  /** Nudge the playback tempo scale by `delta` (e.g. +0.1 = 10% faster). */
  nudgeTempo: (delta: number) => void;
  /** Nudge the playhead by `deltaBeat` beats, clamped to {@link timelineBeats};
   *  re-anchors playback. */
  seekBy: (deltaBeat: number) => void;
  /** Seek the playhead to an absolute `beat`, clamped to {@link timelineBeats}
   *  (so a caller may pass an out-of-range beat and MUST NOT pre-clamp);
   *  re-anchors playback. */
  seekTo: (beat: number) => void;
  /**
   * Single-press jump along the tempo-adaptive seek grid (`-1` back / `+1`
   * forward): a whole bar at authored tempo, finer the more the tempo is slowed
   * for practice (half-bar, quarter-bar, …; see `seekSubdivisions`). Backward
   * uses a half-unit pivot — past the middle of the current unit it snaps to that
   * unit's start, otherwise to the previous unit — so a tap is always an
   * immediate, meaningful jump and repeated taps walk strictly backward.
   */
  seekBar: (direction: -1 | 1) => void;
  /**
   * Begin a held repeat in `direction` (press-and-hold): steps along the same
   * tempo-adaptive seek grid at an accelerating cadence until `endScrub` —
   * discrete jumps, not a smooth glide. Playback is suspended for the duration
   * and restored on release (mirroring the piano-roll drag-scrub's pause-on-grab
   * / resume-on-settle), so the rapid stepping never thrashes the audio scheduler.
   */
  startScrub: (direction: -1 | 1) => void;
  /** End an in-progress {@link startScrub}: commit the landing beat and, if
   *  playback was running when the hold began, resume it from there. */
  endScrub: () => void;
  /**
   * Set (or clear, with `null`) the A–B practice loop. Clamps `start`/`end`
   * into the score span with a minimum gap so the handles never cross, and
   * clears the loop on an empty score. Stable (reads the live score from a ref).
   */
  setLoop: (next: LoopRange | null) => void;
  /** Set the loop's repeat options (the loop UI pushes the user's preference). */
  setLoopOptions: (options: LoopOptions) => void;
  /** Set the playback tempo multiplier (clamped to [0, 4]; 0 freezes playback). */
  setTempoScale: (scale: number) => void;

  play: () => void;
  stop: () => void;
  /**
   * Start playback, optionally preceded by a metronome count-in. If a count-in
   * provider is registered and returns a positive lead-in, this parks the cursor
   * and sets `countIn` (the metronome clicks it out and calls `finishCountIn`);
   * otherwise it plays immediately. The play button + Space route through this so
   * the lead-in only happens on a deliberate play (not scrub-release / auto-play).
   */
  playWithCountIn: () => void;
  /**
   * Begin real playback at the parked start beat once a count-in completes —
   * called by the metronome off the audio clock. No-op if no count-in is pending.
   */
  finishCountIn: () => void;
  /**
   * Register the count-in length provider (the metronome). The provider returns
   * the lead-in length in quarter-note beats for a play-from-the-current-cursor
   * (0 = no count-in). Returns an unregister. Mirrors `registerClock`: a single
   * provider, last registration wins.
   */
  registerCountIn: (provider: () => number) => () => void;
  /**
   * Arm a one-shot "auto-play once the next loaded content is composed". The
   * library's background-play affordance calls this right after loading a song,
   * so it starts playing in place (no navigation) as soon as the recomposed
   * score is ready. Consumed exactly once by the content-reset; a no-op if the
   * score ends up empty.
   */
  requestPlayOnLoad: () => void;
  /**
   * Arm a one-shot "park the cursor at `target(score)` once the next loaded
   * content is composed" — instead of the timeline origin the reset parks at
   * otherwise. The target is a function of the NEW score because a caller that
   * arms it before loading (a deep link's bar) cannot know the beat yet: a bar's
   * start depends on the song's meter map. The sibling of
   * {@link requestPlayOnLoad}, consumed by the same reset (both may be armed:
   * the song then plays from the target). The beat is clamped to the new
   * content's timeline.
   */
  requestSeekOnLoad: (target: (score: Score) => number) => void;

  /**
   * Register the authoritative playback clock (e.g. the audio engine's
   * `AudioContext`). Clocks stack: the last registered is active, and its
   * unregister restores the one below it (the wall clock at the bottom).
   * Swapping the clock mid-playback re-anchors so the cursor stays continuous.
   */
  registerClock: (clock: TransportClock) => () => void;
  /**
   * Register an external medium that owns the position (see
   * {@link TransportDriver}). Drivers stack like clocks: the last registered
   * drives, and its unregister restores the previous one — or the anchored
   * clock, from the cursor, without stopping playback. A newly active driver is
   * sought to the cursor (and started when the transport plays).
   */
  registerTransportDriver: (driver: TransportDriver) => () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Read the playback session. Throws outside `<PlaybackSession>`. */
export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within <PlaybackSession>");
  }
  return ctx;
}

/** The default time source: the browser wall clock, in seconds. */
const wallClock: TransportClock = {
  now: () => performance.now() / 1000,
  drawNow: () => performance.now() / 1000,
  latency: () => 0,
};

/**
 * One playback session over `content`: the tempo-scaled score, the transport
 * (a `requestAnimationFrame` loop — no polling — advancing the per-surface
 * cursor by mapping elapsed clock seconds back through the tempo map), the A–B
 * loop and the count-in. Must be mounted inside a `<CursorStoreProvider>`,
 * which it writes (it is the cursor's sole writer during playback).
 *
 * Folds every `SonataSession.Provider` contribution around its children, inside
 * the session context so a wrapper may `useSession()`.
 */
export function PlaybackSession({
  content,
  children,
}: {
  content: SessionContent;
  children: ReactNode;
}) {
  // The per-surface cursor store's imperative facade. Memoized on the stable
  // store, so it is referentially stable across renders — safe to read
  // directly in the rAF loop and stable callbacks without a ref. This session
  // is the sole writer (`cursor.setBeat`); reads use `cursor.getBeat()`.
  const cursor = useCursorApi();

  const contentKey = content.contentKey;
  const contentPending = content.kind === "pending";
  const contentEmpty = content.kind === "empty";
  // The composed score before tempo scaling — empty unless the content is ready.
  const readyScore = content.kind === "ready" ? content.score : null;
  // Memoized so a not-ready session keeps one empty score identity (no spurious
  // re-anchor or tempo-index rebuild while content loads).
  const baseScore = useMemo<Score>(
    () => readyScore ?? emptyScore(),
    [readyScore],
  );

  // The playhead lives in the per-surface cursor store (not React state) so the
  // ~60fps transport advance doesn't re-render every `useSession()` consumer.
  const [isPlaying, setIsPlaying] = useState(false);
  const [tempoScale, setTempoScaleState] = useState(1);
  // The playback timeline every follower reads (the cursor below, the audio
  // schedulers). The session is its only writer.
  const [timelineStore] = useState(createTimelineStore);
  // A–B practice loop range (beats), or null when unset, and how it repeats.
  // Playback reads them as `loopCycle` (below).
  const [loop, setLoopState] = useState<LoopRange | null>(null);
  const [loopOptions, setLoopOptions] = useState<LoopOptions>(NO_LOOP_OPTIONS);
  // A pending count-in lead-in (metronome), or null. State (not a ref) so the
  // metronome engine + countdown HUD react to it. While set, `isPlaying` stays
  // false, so the rAF below never runs and the cursor parks at the start beat.
  const [countIn, setCountIn] = useState<CountInState | null>(null);
  const countInRef = useLatestRef(countIn);
  // The registered count-in length provider (the metronome), read at play time.
  // Mirrors `clockRef`: a single provider, last registration wins.
  const countInProviderRef = useRef<(() => number) | null>(null);
  // The registered drivers, last on top; `driver` is the top one, as state so
  // the play/pause sync and the subscription follow it.
  const driversRef = useRef<TransportDriver[]>([]);
  const [driver, setDriver] = useState<TransportDriver | null>(null);
  const driverRef = useLatestRef(driver);

  // Fold the tempo scale into the tempo map ONCE here, so every consumer — the
  // transport loop below, the audio scheduler, and the displays — reads a single
  // consistent timeline. Beats are untouched (analyzers already ran on the
  // unscaled score), only the beat→seconds mapping speeds up or slows down.
  const score = useMemo<Score>(
    () => scaleTempo(baseScore, Math.max(tempoScale, TEMPO_MATH_FLOOR)),
    [baseScore, tempoScale],
  );

  // Precompute the beat↔seconds index once per score. Both directions are
  // O(log n) closed-form, so the transport loop and the timeline read a single,
  // allocation-free tempo-time source instead of re-sorting the tempo map.
  const tempoIndex = useMemo(() => buildTempoIndex(score), [score]);
  // The UNSCALED index: its seconds are a driver's media seconds, so a driver's
  // position maps to a beat whatever the tempo scale (beats are scale-free).
  const mediaIndex = useMemo(() => buildTempoIndex(baseScore), [baseScore]);
  const mediaIndexRef = useLatestRef(mediaIndex);

  // The loop as playback cycles it (see `SessionValue.loopCycle`). Built from
  // primitives so its identity survives a tempo change (which re-derives
  // `score` but never the meter). A new timeline path reads it through the ref.
  const loopStart = loop?.enabled ? loop.start : null;
  const loopEnd = loop?.enabled ? loop.end : null;
  const restBeats =
    loopStart !== null && loopOptions.rest && driver === null
      ? barBeatsAt(score, loopStart)
      : 0;
  const loopCycle = useMemo<LoopCycle | null>(
    () =>
      loopStart !== null && loopEnd !== null && loopEnd > loopStart
        ? { start: loopStart, end: loopEnd, rest: restBeats }
        : null,
    [loopStart, loopEnd, restBeats],
  );
  const loopCycleRef = useLatestRef(loopCycle);

  // The timeline origin: the beat the transport parks/starts at and the
  // backward-most stop every rewind/scrub bottoms out on. For a non-empty score
  // this is the one-bar Synthesia-style lead-in pre-roll — a stretch of empty
  // timeline at NEGATIVE beats `[startBeat, 0)` — so the piano roll's first
  // notes have a bar of travel toward the strike line instead of opening pinned
  // to it. It carries no notes/sound; the tempo index extrapolates it linearly
  // and the audio scheduler simply schedules beat-0 notes one bar into the
  // future — so nothing downstream special-cases it. Zero for an empty score.
  // `scoreStartBeat` is THE single source of truth for this bound (mirror of
  // `scoreEndBeat`), so the reset effect, `seekTo`'s clamp, and the bar-seek /
  // scrub floors all agree that "the start" is the empty lead-in bar. Read
  // through a ref by the content-reset effect below.
  const startBeat = useMemo(() => scoreStartBeat(score), [score]);
  const startBeatRef = useLatestRef(startBeat);

  // The seekable span, published so navigation surfaces consume the bound instead
  // of reconstructing it. `seekTo` owns the clamp; a consumer reads this only when
  // it needs the span as a *value* (e.g. the piano-roll drag's rubber-band bounds).
  const timelineBeats = useMemo(
    () => [startBeat, scoreEndBeat(score)] as const,
    [startBeat, score],
  );

  // --- Transport: a requestAnimationFrame loop (no polling). ----------------
  // While playing on the session's own clock, the cursor is the timeline read
  // at the clock's `now()` each frame. The time source is the pluggable
  // `clockRef` — the audio engine registers its `AudioContext.currentTime`, the
  // clock its schedulers place notes on, through the SAME timeline. rAF only
  // sets the *render cadence*; it does not supply the time value (so a
  // backgrounded-then-resumed tab reads the live clock and lands the cursor
  // exactly where the sound is). Each read is O(log n) in the tempo-map size.
  const rafRef = useRef<number | null>(null);
  const clockRef = useRef<TransportClock>(wallClock);
  // Registered clocks, last on top; `clockRef` is the top one (or the wall clock).
  const clocksRef = useRef<TransportClock[]>([]);
  // The last timeline path's id, minted on every restart.
  const generationRef = useRef(0);
  // The path and loop iteration the cursor was last drawn in, so the tick can
  // flag a wrap (an iteration change on the same path) to the cursor store as a
  // `seek` — making onset-driven consumers (the piano-roll FX) re-anchor
  // instead of spraying every note between B and A. A new path is not a wrap:
  // a jump already wrote its own seek, and a continued one is continuous.
  const drawnRef = useRef<{ path: PlaybackPath | null; iter: number }>({
    path: null,
    iter: 0,
  });
  // The beat the active driver is known to be at: written every driven frame
  // and on every seek the session sends it. Resuming compares the cursor with
  // it to decide whether the driver must first be sought to the cursor (after a
  // scrub, which moves only the cursor).
  const driverAtBeatRef = useRef<number | null>(null);
  // An A–B wrap sought the driver back to A and the medium has not reported a
  // position before B since.
  const wrapPendingRef = useRef(false);
  // One-shot load intents (auto-play / park-at-beat once the freshly loaded
  // content is composed), consumed by the content-reset effect below. Refs (not
  // state) so arming one never triggers a render.
  const playOnLoadRef = useRef(false);
  const seekOnLoadRef = useRef<((score: Score) => number) | null>(null);
  const scoreRef = useLatestRef(score);
  const tempoIndexRef = useLatestRef(tempoIndex);
  // Live mirrors so stable callbacks (seek, restarts, clock swaps, store
  // actions) read current values WITHOUT depending on them.
  // The cursor's live value comes from the store via `cursor.getBeat()`.
  const isPlayingRef = useLatestRef(isPlaying);
  const tempoScaleRef = useLatestRef(tempoScale);

  // Which timeline was in force at each recent render instant, so the cursor
  // reads the music being HEARD (see `HeardTimeline`). Fed by every timeline
  // write below — `setIdle` / `setRunning` are the only writers of the store.
  const [heard] = useState(createHeardTimeline);
  const heardNow = useCallback(
    () => clockRef.current.now() - clockRef.current.latency(),
    [],
  );

  const setIdle = useCallback(() => {
    heard.clear();
    timelineStore.set({ kind: "idle" });
  }, [heard, timelineStore]);

  // Publish `timeline`, taking over at render time `from` (see
  // `TimelineTakeover`): a new `generation` replaces the path, the same one
  // only re-times it.
  const setRunning = useCallback(
    (
      timeline: PlaybackTimeline,
      generation: number,
      from: number,
      takeover: TimelineTakeover,
    ) => {
      heard.push(timeline, from, takeover);
      timelineStore.set({ kind: "running", generation, timeline });
    },
    [heard, timelineStore],
  );

  // Start a new timeline path at `from`, sounding at render time `at` (the
  // active clock's `now()` unless given): then the music walks on (into the A–B
  // loop, when one is on; a position inside a loop's rest or repeat resumes
  // there). The one way a path starts — play, seek, a loop edit, a driver's
  // jump — so every follower restarts from the same position at the same
  // instant. `takeover` says whether the music carries on through the restart
  // (a loop edit from where it is) or jumps (play, a seek). Not playing:
  // nothing sounds.
  const startAt = useCallback(
    (
      from: PlayPosition,
      takeover: TimelineTakeover,
      at: number = clockRef.current.now(),
    ) => {
      if (!isPlayingRef.current) {
        setIdle();
        return;
      }
      generationRef.current += 1;
      setRunning(
        startTimeline(from, loopCycleRef.current, tempoIndexRef.current, at),
        generationRef.current,
        at,
        takeover,
      );
    },
    [setIdle, setRunning],
  );

  // Where the music is right now: the running timeline at the clock's `now()`
  // — exact, unlike the cursor, which holds the position of the last frame —
  // or the parked cursor when nothing sounds.
  const livePosition = useCallback((): PlayPosition => {
    const state = timelineStore.get();
    return state.kind === "running"
      ? state.timeline.positionAt(clockRef.current.now())
      : cursor.getPosition();
  }, [timelineStore, cursor]);

  const registerClock = useCallback(
    (clock: TransportClock) => {
      // Carry the running timeline onto the new clock: what sounds now on the
      // old one sounds now on the new one.
      const swapTo = (next: TransportClock) => {
        const prev = clockRef.current;
        clockRef.current = next;
        const state = timelineStore.get();
        if (state.kind !== "running") return;
        // The heard history's instants belong to the old clock: start it over
        // on the new one, the rebased timeline in force throughout.
        setRunning(
          rebaseTimeline(state.timeline, prev.now(), next.now()),
          state.generation,
          -Infinity,
          "jump",
        );
      };
      clocksRef.current = [...clocksRef.current, clock];
      swapTo(clock);
      return () => {
        clocksRef.current = clocksRef.current.filter((c) => c !== clock);
        const top = clocksRef.current.at(-1) ?? wallClock;
        if (clockRef.current === top) return;
        swapTo(top);
      };
    },
    [timelineStore, setRunning],
  );

  // Seek the active driver to `beat` (its media seconds, floored at the
  // medium's start). Records where it now is, so resuming does not seek again.
  const seekDriver = useCallback((d: TransportDriver, beat: number) => {
    d.seek(Math.max(0, mediaIndexRef.current.beatToSeconds(beat)));
    driverAtBeatRef.current = beat;
  }, []);

  const registerTransportDriver = useCallback(
    (d: TransportDriver) => {
      driversRef.current = [...driversRef.current, d];
      setDriver(d);
      return () => {
        const wasTop = driversRef.current.at(-1) === d;
        driversRef.current = driversRef.current.filter((x) => x !== d);
        if (!wasTop) return;
        const next = driversRef.current.at(-1) ?? null;
        setDriver(next);
        // Back on the session's clock: carry on from where the music is.
        if (next === null && isPlayingRef.current) {
          startAt(livePosition(), "continue");
        }
      };
    },
    [startAt, livePosition],
  );

  const readDriver = useCallback((): DriverReading => {
    const d = driverRef.current;
    if (d === null) return { kind: "internal" };
    const pos = d.position();
    if (pos === null) return { kind: "stalled" };
    return {
      kind: "advancing",
      beat: mediaIndexRef.current.secondsToBeat(pos),
    };
  }, []);

  // Start a new path from where the transport stands now: the driver's beat
  // when one owns the position (nothing while it is stalled — the driven tick
  // starts one when it advances), else the live beat — the music carries on
  // through the restart (when nothing sounded yet, there is nothing to carry).
  // A medium's position is what is heard now, so its path starts at the heard
  // instant: the synth's note for that beat is heard with the medium's.
  const restartHere = useCallback(() => {
    const reading = readDriver();
    switch (reading.kind) {
      case "internal":
        startAt(livePosition(), "continue");
        return;
      case "stalled":
        setIdle();
        return;
      case "advancing":
        startAt(songPosition(reading.beat), "jump", heardNow());
        return;
    }
  }, [readDriver, startAt, livePosition, setIdle, heardNow]);

  const stop = useCallback(() => {
    // Abort any pending count-in too, so Stop during the lead-in cancels it.
    setCountIn(null);
    setIsPlaying(false);
  }, []);

  const play = useCallback(() => {
    if (scoreEndBeat(scoreRef.current) <= 0) return;
    // 0% is a frozen transport — there is nothing to advance, so don't start.
    if (tempoScaleRef.current === 0) return;
    setIsPlaying(true);
  }, []);

  // Register the count-in length provider (the metronome). Mirrors registerClock.
  const registerCountIn = useCallback((provider: () => number) => {
    countInProviderRef.current = provider;
    return () => {
      if (countInProviderRef.current === provider) {
        countInProviderRef.current = null;
      }
    };
  }, []);

  // Begin real playback at the parked start beat once the lead-in completes.
  // Called by the metronome off the audio clock (and a no-op if nothing pending).
  const finishCountIn = useCallback(() => {
    setCountIn(null);
    play();
  }, [play]);

  // Start playback, optionally preceded by a metronome count-in. The play button
  // + Space route through this; the internal resume paths (endScrub, auto-play-
  // on-load) call play() directly so they never trigger a lead-in. Guards mirror
  // play() so we never arm a count-in that then can't start (empty / frozen).
  const playWithCountIn = useCallback(() => {
    if (isPlayingRef.current) return;
    if (scoreEndBeat(scoreRef.current) <= 0) return;
    if (tempoScaleRef.current === 0) return;
    // The count-in is clicked out on the audio clock, which a driver does not
    // follow: with a medium driving, play at once (it has its own intro).
    if (driverRef.current !== null) {
      play();
      return;
    }
    const lead = countInProviderRef.current?.() ?? 0;
    if (lead <= 0) {
      play();
      return;
    }
    const fromBeat = cursor.getBeat();
    const idx = tempoIndexRef.current;
    // Seconds per quarter-note at the start beat = the lead-in tempo.
    const secPerQuarter =
      idx.beatToSeconds(fromBeat + 1) - idx.beatToSeconds(fromBeat);
    setCountIn({
      startBeat: fromBeat,
      beats: lead,
      startedAtClockSec: clockRef.current.now(),
      durationSec: lead * secPerQuarter,
    });
  }, [play, cursor]);

  const requestPlayOnLoad = useCallback(() => {
    playOnLoadRef.current = true;
  }, []);

  const requestSeekOnLoad = useCallback((target: (score: Score) => number) => {
    seekOnLoadRef.current = target;
  }, []);

  // Reset the transport whenever the loaded CONTENT changes (new/changed song).
  //
  // The trigger is `contentKey` — the identity of the loaded TIMELINE — NOT the
  // composed `score`. The document layers pure *view transforms* on top of the
  // same timeline (transpose, chord voicing, key auto-detect, spelling,
  // analysis): those shift pitches / re-voice / re-spell but leave the TIMELINE
  // (note onsets, durations, tempo map) identical, so the current playhead stays
  // meaningful and must NOT rewind. Keying on the score made every such
  // transform rewind to 0 and stop playback — e.g. nudging transpose mid-song
  // restarted it. The audio engine and piano roll already re-derive from the
  // new `score` and reschedule from the *live* cursor, so transforms apply
  // seamlessly during playback. `contentKey` changes only on a real input
  // load/edit, so loading or editing a song still rewinds + (re)arms the load
  // intents.
  //
  // If a load intent is armed (`requestPlayOnLoad` / `requestSeekOnLoad`), the
  // reset honours it once the new score is composed: it parks at the requested
  // beat instead of the origin, and starts playback instead of stopping;
  // `play`'s own guards keep an empty/0% score from starting.
  //
  // New content that is still `pending` (its song settings are loading) is not
  // composed yet: it stops the transport at once — the previous song must not
  // play on over the load — and the rewind + load intents wait for it to
  // compose, when the start beat is the real score's. `resetForRef` is the
  // content the last full reset ran for, so settings that re-settle over the
  // SAME content never rewind it.
  const resetForRef = useRef<object | null>(null);
  useEffect(() => {
    if (contentKey === resetForRef.current) return;
    /* eslint-disable react-hooks/set-state-in-effect -- intentional transport reset on content change: every state write here is paired with the imperative cursor rewind (cursor.setBeat) or the play-on-load start, a genuine side-effect not derivable in render */
    if (contentPending) {
      setCountIn(null);
      setIsPlaying(false);
      return;
    }
    resetForRef.current = contentKey;
    // Nothing loaded: rewind and stop, but leave the load intents armed — they
    // target the next real load. A host arms them before its first load, and
    // its mount effect runs before this (ancestor) effect's first run, which
    // sees the session's initial empty content.
    if (contentEmpty) {
      cursor.setBeat(startBeatRef.current, { seek: true });
      setLoopState(null);
      setCountIn(null);
      setIsPlaying(false);
      return;
    }
    // Park at the requested beat when one was armed, else at the timeline
    // origin (the negative lead-in pre-roll beat), not beat 0, so a freshly
    // loaded song opens with an empty bar below its first notes and — whether
    // it auto-plays or the user presses play — the notes fall INTO the strike
    // line rather than starting on it. `startBeatRef` / `scoreRef` mirror the
    // memos derived from this same content, so by the time this post-commit
    // effect runs they already hold the new song's values.
    const requested = seekOnLoadRef.current;
    seekOnLoadRef.current = null;
    const origin = startBeatRef.current;
    const start =
      requested === null
        ? origin
        : Math.max(
            origin,
            Math.min(
              scoreEndBeat(scoreRef.current),
              requested(scoreRef.current),
            ),
          );
    cursor.setBeat(start, { seek: true });
    // Drop any A–B loop: it belongs to the previous content's beat span. Cleared
    // unconditionally (even when auto-playing) so a freshly loaded song never
    // inherits a stale practice loop.
    setLoopState(null);
    // A freshly loaded song never inherits a stale count-in (its lead-in belonged
    // to the previous content). Paired with the imperative cursor rewind above.
    setCountIn(null);
    // Re-base the transport to the new start. When the previous song was
    // already playing, `isPlaying` stays true across the switch, so `play()`
    // causes no play/pause transition and the rAF loop — still on the previous
    // song's timeline — would clobber the `setBeat(start)` above on its next
    // tick. Starting a new path here (the audio schedulers restart with it)
    // makes every loaded song start from its start beat, whether or not
    // playback was already running.
    if (playOnLoadRef.current) {
      playOnLoadRef.current = false;
      startAt(songPosition(start), "jump");
      play();
    } else {
      // Loading/editing new content rewinds the cursor above and stops playback.
      setIsPlaying(false);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // Keyed on `contentKey` (the loaded timeline), NOT `score` — so the pitch /
    // voicing / key view-transforms layered over the same timeline don't rewind
    // or stop playback (they apply live). `play`/`startAt` are stable.
    // `contentPending` only defers the reset of new content until it composes.
  }, [contentKey, contentPending, contentEmpty, cursor, play, startAt]);

  // Absolute seek — the primitive the progression bar drives. Clamps to the
  // score span and, while playing, starts a new path there (sound and cursor
  // follow the same one).
  // Stable (reads refs internally), so pointer handlers stay correct mid-drag.
  const seekTo = useCallback(
    (beat: number) => {
      const score = scoreRef.current;
      const end = scoreEndBeat(score);
      // Clamp to the full timeline `[scoreStartBeat, end]` — the lower bound is
      // the lead-in origin, NOT 0, so rewinding/scrubbing can reach the empty
      // pre-roll bar (where the first note is still falling) rather than flooring
      // on the first note itself.
      const next = Math.max(scoreStartBeat(score), Math.min(end, beat));
      const d = driverRef.current;
      if (d !== null) seekDriver(d, next);
      // A seek aborts a pending count-in (you've repositioned; the lead-in is
      // stale). No-op re-render when already null — React bails on the same value.
      setCountIn(null);
      cursor.setBeat(next, { seek: true });
      if (isPlayingRef.current) startAt(songPosition(next), "jump");
    },
    [startAt, cursor, seekDriver],
  );

  // Relative seek (keyboard arrows) delegates to the absolute primitive.
  const seekBy = useCallback(
    (deltaBeat: number) => seekTo(cursor.getBeat() + deltaBeat),
    [seekTo, cursor],
  );

  // Single-press jump along the tempo-adaptive seek grid (a whole bar at normal
  // speed, finer as the tempo is slowed; see `seekSubdivisions`). Goes through
  // `seekTo`, so a tap while playing jumps the audio and keeps going. Reads the
  // live cursor + score + tempo from refs so it stays stable.
  const seekBar = useCallback(
    (direction: -1 | 1) => {
      const score = scoreRef.current;
      const here = cursor.getBeat();
      const end = scoreEndBeat(score);
      // The seek grid runs `[0, end]`; the timeline origin (the lead-in pre-roll)
      // sits one unit below it, supplied as the backward `min` clamp so a rewind
      // off beat 0 lands on the empty lead-in bar rather than sticking at 0.
      const start = scoreStartBeat(score);
      const grid = subdivideBars(
        score,
        seekSubdivisions(tempoScaleRef.current),
      );
      if (direction > 0) {
        seekTo(nextLine(grid, here, end));
        return;
      }
      // Backward: half-unit pivot. Past the middle of the current unit → snap to
      // its start (replay this unit); in the first half → step to the previous
      // unit. The target is always ≤ the current line ≤ here, so repeated taps
      // walk strictly backward — drift-proof while playing, with no play/pause
      // special-case.
      const cur = currentLine(grid, here, start);
      const next = nextLine(grid, here, end);
      seekTo(here > (cur + next) / 2 ? cur : prevLine(grid, cur, start));
    },
    [seekTo, cursor],
  );

  // --- Press-and-hold repeat. ----------------------------------------------
  // A self-driven rAF loop that steps the cursor bar-by-bar at an accelerating
  // cadence while a control is held — discrete jumps (NOT a smooth glide), like
  // holding the rewind key in a media player. Playback is suspended for the
  // duration so the rapid stepping never re-anchors / restarts the audio
  // scheduler per step; a single clean re-anchor happens in `endScrub`. Cadence
  // timing reads the wall clock directly (`performance.now`), NOT the transport
  // clock: while paused the audio clock (`ctx.currentTime`) is frozen, so it
  // would report `dt = 0` and the hold would never advance.
  const scrubRafRef = useRef<number | null>(null);
  const scrubWasPlayingRef = useRef(false);

  const startScrub = useCallback(
    (direction: -1 | 1) => {
      if (scrubRafRef.current !== null) return; // already holding
      const score = scoreRef.current;
      const end = scoreEndBeat(score);
      if (end <= 0) return;
      // Backward hold bottoms out at the timeline origin (the lead-in pre-roll),
      // not 0 — same lower bound as the tap-rewind and `seekTo` clamp.
      const start = scoreStartBeat(score);

      // The seek grid for this hold — captured once: playback is suspended for the
      // duration, so neither the score nor the tempo can shift the unit mid-hold.
      const grid = subdivideBars(
        score,
        seekSubdivisions(tempoScaleRef.current),
      );

      // Suspend playback while holding; remember whether to resume on release.
      scrubWasPlayingRef.current = isPlayingRef.current;
      if (isPlayingRef.current) setIsPlaying(false);

      // Seconds between bar steps: starts spaced out so a brief hold steps a few
      // bars, then tightens the longer it's held so a far rewind doesn't crawl.
      const START_INTERVAL = 0.16;
      const MIN_INTERVAL = 0.05;
      const ACCEL = 0.06; // interval shaved per second held

      let last = performance.now() / 1000;
      let held = 0;
      let acc = 0;
      const step = () => {
        const now = performance.now() / 1000;
        const dt = now - last;
        last = now;
        held += dt;
        acc += dt;
        const interval = Math.max(MIN_INTERVAL, START_INTERVAL - held * ACCEL);
        if (acc >= interval) {
          acc = 0;
          const here = cursor.getBeat();
          const next =
            direction < 0
              ? prevLine(grid, here, start)
              : nextLine(grid, here, end);
          // Move the visual cursor directly — no `seekTo` (no new timeline
          // path) since playback is suspended. The store write is read back by the
          // next step's `cursor.getBeat()` and the final `endScrub` commit. A
          // bar-jump is navigation, not playback — flag it a seek so onset FX
          // don't fire on every step.
          if (next !== here) cursor.setBeat(next, { seek: true });
        }
        scrubRafRef.current = requestAnimationFrame(step);
      };
      scrubRafRef.current = requestAnimationFrame(step);
    },
    [cursor],
  );

  const endScrub = useCallback(() => {
    if (scrubRafRef.current === null) return;
    cancelAnimationFrame(scrubRafRef.current);
    scrubRafRef.current = null;
    if (scrubWasPlayingRef.current) {
      // Resuming re-anchors at the landing beat and reschedules audio once.
      scrubWasPlayingRef.current = false;
      play();
    } else {
      // Paused: commit the landing beat (re-anchor + signal once) so a later
      // play starts from exactly where the scrub stopped.
      seekTo(cursor.getBeat());
    }
  }, [play, seekTo, cursor]);

  // Cancel any in-flight scrub loop on unmount so the rAF doesn't outlive us.
  useEffect(() => {
    return () => {
      if (scrubRafRef.current !== null)
        cancelAnimationFrame(scrubRafRef.current);
    };
  }, []);

  // Set / clear the A–B loop. Reads the live score from `scoreRef` so it stays
  // stable. `null` clears; an empty score (`scoreEndBeat <= 0`) can't host a
  // loop, so it clears too. Otherwise clamp both edges into [0, end] and keep a
  // `LOOP_MIN_GAP` between them so the handles can never cross or collapse.
  const setLoop = useCallback((next: LoopRange | null) => {
    if (!next) {
      setLoopState(null);
      return;
    }
    const end = scoreEndBeat(scoreRef.current);
    if (end <= 0) {
      setLoopState(null);
      return;
    }
    const start = Math.max(0, Math.min(next.start, end - LOOP_MIN_GAP));
    const stop = Math.max(start + LOOP_MIN_GAP, Math.min(next.end, end));
    setLoopState({ start, end: stop, enabled: next.enabled });
  }, []);

  // Continuous (clamp only, no grid) so a jog-wheel / pinch drag scrubs smoothly
  // with fine-grained control and a clean release fling. The tidy 0.05 grid
  // lives in `nudgeTempo`, where repeated *relative* additions are the only
  // thing that would accrue float drift.
  //
  // With a driver the medium decides: the rate is asked of it and the rate it
  // took becomes the scale, so the UI never shows a speed it is not playing.
  // Only the latest request is adopted (a jog-wheel drag sends many). 0 is the
  // session's freeze, not a rate: it pauses the driver like any stop.
  const rateRequestRef = useRef(0);
  const setTempoScale = useCallback((scale: number) => {
    const clamped = Math.max(MIN_TEMPO_SCALE, Math.min(MAX_TEMPO_SCALE, scale));
    const d = driverRef.current;
    const request = ++rateRequestRef.current;
    if (d === null || clamped === 0) {
      setTempoScaleState(clamped);
      return;
    }
    void d.setRate(clamped).then((taken) => {
      if (request !== rateRequestRef.current || driverRef.current !== d) return;
      setTempoScaleState(
        Math.max(MIN_TEMPO_SCALE, Math.min(MAX_TEMPO_SCALE, taken)),
      );
    });
  }, []);

  // A tempo change (the speed wheel, a driver's rate) re-times the running
  // timeline from NOW: what sounds at this instant keeps sounding, everything
  // after it follows the new tempo. Derived from the timeline itself at the
  // clock's `now()` — never from the cursor, which holds the beat of the last
  // frame: re-anchoring on that lost the time since the frame on every change,
  // ~60 times a second during a drag, and the cursor fell behind the sound.
  //
  // A layout effect, so the new timeline is in place in the same commit as the
  // new `score`, before the next rAF tick reads either; the audio schedulers
  // are subscribed to the store and re-time in the same call.
  useLayoutEffect(() => {
    const state = timelineStore.get();
    if (state.kind !== "running") return;
    const now = clockRef.current.now();
    setRunning(
      retempoTimeline(state.timeline, tempoIndex, now),
      state.generation,
      now,
      "continue",
    );
  }, [tempoIndex, timelineStore, setRunning]);

  // 0% speed freezes the transport: pause so neither the cursor nor the audio
  // advances. Stepping the speed back up requires pressing play again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: freeze transport at 0% tempo (a 0× scale cannot advance the cursor); this is a transport state transition triggered by the user dialing tempo to 0 while playing, not derivable in render (isPlaying is imperative play/pause state)
    if (tempoScale === 0) setIsPlaying(false);
  }, [tempoScale]);

  useEffect(() => {
    if (!isPlaying) {
      setIdle();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    // Start the path at the cursor (or where the medium is) on the play.
    restartHere();

    // Driven: the medium owns the position — the cursor shows it, and the
    // timeline the synth sounds is kept within DRIFT_TOLERANCE_SEC of it. The
    // A–B loop cannot fold a medium seamlessly, so the wrap is a seek.
    const drivenTick = (d: TransportDriver) => {
      const pos = d.position();
      if (pos === null) {
        // Not advancing (buffering, seeking): nothing may sound.
        setIdle();
      } else {
        const beat = mediaIndexRef.current.secondsToBeat(pos);
        const endBeat = scoreEndBeat(scoreRef.current);
        // A driven cycle never rests (see `SessionValue.loopCycle`).
        const cycle = loopCycleRef.current;
        if (cycle && wrapPendingRef.current && beat >= cycle.end) {
          // The wrap's seek has not landed yet: the medium still reports the
          // old position. Hold the cursor at A rather than wrap again.
        } else if (cycle && beat >= cycle.end) {
          seekDriver(d, cycle.start);
          wrapPendingRef.current = true;
          cursor.setBeat(cycle.start, { seek: true });
          startAt(songPosition(cycle.start), "jump", heardNow());
        } else if (beat >= endBeat) {
          cursor.setBeat(endBeat);
          setIsPlaying(false);
          return;
        } else {
          wrapPendingRef.current = false;
          driverAtBeatRef.current = beat;
          cursor.setBeat(beat);
          followDriver(beat);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    // Keep the timeline on the medium at `beat`: start it when nothing
    // sounds yet (the medium just began advancing), re-anchor it when it
    // slipped past the tolerance (compared in seconds at the PLAYING tempo, so
    // the tolerance is wall time whatever the speed). The medium's position is
    // what is HEARD now, so it is matched against the timeline at the heard
    // instant — the synth renders `beat` one output latency earlier, and the
    // two reach the ears together.
    const followDriver = (beat: number) => {
      const state = timelineStore.get();
      const at = heardNow();
      if (state.kind !== "running") {
        startAt(songPosition(beat), "jump", at);
        return;
      }
      const { timeline } = state;
      const slip =
        timeline.tempo.beatToSeconds(timeline.beatOf(timeline.cAt(at))) -
        timeline.tempo.beatToSeconds(beat);
      if (Math.abs(slip) > DRIFT_TOLERANCE_SEC) {
        setRunning(
          resyncTimeline(timeline, beat, at),
          state.generation,
          at,
          "continue",
        );
      }
    };

    const tick = () => {
      const d = driverRef.current;
      if (d !== null) {
        drivenTick(d);
        return;
      }
      // The music being heard — one output latency behind what is rendered,
      // on the timeline that scheduled it — read on the clock's continuous
      // drawing time so the cursor glides instead of stepping per buffer.
      const reading = heard.read(
        clockRef.current.drawNow() - clockRef.current.latency(),
      );
      if (reading === null) return;
      const { timeline, c } = reading;

      // A–B loop: the timeline folds the walk into the loop's iterations
      // itself — a repeat's rest included — and the audio schedulers walk the
      // same path, so the cursor and the sound wrap together. A wrap is just
      // an iteration change; on it we flag the cursor write as a `seek` so
      // onset-driven FX re-anchor instead of spraying every note between B and
      // A. A loop ending exactly at the song end cycles its tail rather than
      // stopping.
      if (timeline.path.cycle) {
        const iter = timeline.iterationOf(c);
        const drawn = drawnRef.current;
        const wrapped = drawn.path === timeline.path && drawn.iter !== iter;
        drawnRef.current = { path: timeline.path, iter };
        cursor.setPosition(
          timeline.positionOf(c),
          wrapped ? { seek: true } : undefined,
        );
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // The tempo index isn't clamped to scoreEndBeat, so we clamp here.
      const beat = timeline.beatOf(c);
      const endBeat = scoreEndBeat(scoreRef.current);
      if (beat >= endBeat) {
        cursor.setBeat(endBeat);
        setIsPlaying(false);
        return;
      }
      cursor.setBeat(beat);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // Runs only on play/stop transitions — the loop owns the cursor while
    // playing. Every other dependency is stable (memoized callbacks, the
    // store, latest-refs).
  }, [
    isPlaying,
    restartHere,
    startAt,
    cursor,
    seekDriver,
    timelineStore,
    heard,
    heardNow,
    setIdle,
    setRunning,
  ]);

  // --- The driver follows the transport. ------------------------------------
  // `isPlaying` stays the session's intent; the active driver is told. Before
  // that it is sought to the cursor whenever the two disagree — a driver that
  // just became active, or a scrub that moved only the cursor: while paused the
  // cursor is the authority, while playing the medium is. A layout effect, so
  // the medium starts in the same commit as the transport.
  useLayoutEffect(() => {
    if (driver === null) return;
    const here = cursor.getBeat();
    const at = driverAtBeatRef.current;
    const idx = mediaIndexRef.current;
    if (
      at === null ||
      Math.abs(idx.beatToSeconds(here) - idx.beatToSeconds(at)) >
        DRIVER_ALIGN_TOLERANCE_SEC
    ) {
      seekDriver(driver, here);
      // The medium jumped: the music restarts from where it now is.
      if (isPlaying) restartHere();
    }
    if (isPlaying) driver.play();
    else driver.pause();
  }, [driver, isPlaying, cursor, seekDriver, restartHere]);

  // A newly active driver is asked for the current tempo, and adopts the rate
  // it takes. Forgotten on its way out, so a later driver is sought afresh.
  useLayoutEffect(() => {
    if (driver === null) return;
    if (tempoScaleRef.current > 0) setTempoScale(tempoScaleRef.current);
    return () => {
      driverAtBeatRef.current = null;
    };
  }, [driver, setTempoScale]);

  // --- The transport follows the driver's state. ----------------------------
  // A stall or a resume is followed by the driven tick (the timeline goes
  // idle while the medium does not advance, and starts again where it
  // resumes). An external pause — the medium stopped after moving, or failed — stops the
  // transport. The medium never STARTS the transport: a stray advance while the
  // session is stopped (a late play after a quick stop) is paused again, so the
  // session's intent always wins and the two cannot ping-pong.
  useEffect(() => {
    if (driver === null) return;
    let last: DriverState["kind"] | null = null;
    return driver.subscribe((state) => {
      // A driver already unregistered (its medium unmounting) reports its own
      // teardown on the way out; that is the medium going away, not the user
      // pausing it, so the transport — now back on its own clock — ignores it.
      // `driversRef` changes synchronously in the unregister, before this
      // subscription is torn down by the next render.
      if (!driversRef.current.includes(driver)) return;
      const prev = last;
      last = state.kind;
      if (prev === null) return; // the current state, on subscribe: no transition
      const moved = (k: DriverState["kind"] | null) =>
        k === "advancing" || k === "stalled";
      if (state.kind === "advancing" && !isPlayingRef.current) {
        driver.pause();
        return;
      }
      if (
        (state.kind === "failed" || (state.kind === "paused" && moved(prev))) &&
        isPlayingRef.current
      ) {
        setIsPlaying(false);
      }
    });
  }, [driver]);

  // A loop edit mid-play (toggled, bounds moved, the rest switched, a driver
  // come or gone) starts a new path from where the music is now — every
  // follower walks the new cycle from the same position. A *stable* cycle never
  // re-runs this, so a repeated wrap stays seamless.
  useEffect(() => {
    if (isPlayingRef.current) restartHere();
  }, [loopCycle, restartHere]);

  // Stable transport verbs the controls plugin registers as per-surface, focus-
  // scoped keyboard shortcuts (Space / ↑ / ↓ and the ←/→ seek-hold controller).
  const togglePlay = useCallback(() => {
    // Playing OR counting in → stop (so a toggle during the lead-in cancels it);
    // otherwise start, routing through the count-in path.
    if (isPlayingRef.current || countInRef.current) stop();
    else playWithCountIn();
  }, [playWithCountIn, stop]);

  // ↑/↓ keyboard steps: snap the result onto the tidy 0.05 grid so taps land on
  // round percentages (and never accrue float drift), even when the wheel left
  // tempo on a fine off-grid value.
  const nudgeTempo = useCallback(
    (delta: number) =>
      setTempoScale(Math.round((tempoScaleRef.current + delta) * 20) / 20),
    [setTempoScale],
  );

  const value = useMemo<SessionValue>(
    () => ({
      score,
      timelineBeats,
      isPlaying,
      tempoScale,
      timeline: timelineStore,
      driven: driver !== null,
      heardNow,
      loop,
      loopCycle,
      loopOptions,
      countIn,
      togglePlay,
      nudgeTempo,
      seekBy,
      seekTo,
      seekBar,
      startScrub,
      endScrub,
      setLoop,
      setLoopOptions,
      setTempoScale,
      play,
      stop,
      playWithCountIn,
      finishCountIn,
      registerCountIn,
      requestPlayOnLoad,
      requestSeekOnLoad,
      registerClock,
      registerTransportDriver,
    }),
    [
      score,
      timelineBeats,
      isPlaying,
      tempoScale,
      timelineStore,
      driver,
      heardNow,
      loop,
      loopCycle,
      loopOptions,
      countIn,
      togglePlay,
      nudgeTempo,
      seekBy,
      seekTo,
      seekBar,
      startScrub,
      endScrub,
      setLoop,
      setLoopOptions,
      setTempoScale,
      play,
      stop,
      playWithCountIn,
      finishCountIn,
      registerCountIn,
      requestPlayOnLoad,
      requestSeekOnLoad,
      registerClock,
      registerTransportDriver,
    ],
  );

  // Fold every contributed per-session provider around the children, INSIDE the
  // session context so contributed wrappers may `useSession()`. This lets a
  // plugin the player scope can't import (cycle) inject one provider above the
  // session's whole subtree — e.g. an audio engine and a volume control in
  // different slot branches sharing one per-session store.
  return (
    <SessionContext.Provider value={value}>
      <SonataSession.Provider.Wrap>{children}</SonataSession.Provider.Wrap>
    </SessionContext.Provider>
  );
}
