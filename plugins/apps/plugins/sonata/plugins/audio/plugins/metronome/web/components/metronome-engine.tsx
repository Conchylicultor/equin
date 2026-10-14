import { useEffect, useMemo, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import type { InstrumentVoices } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  useAudioGraph,
  startScheduling,
} from "@plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web";
import { useConfig } from "@plugins/config_v2/web";
import { metronomeConfig } from "../../shared/config";
import { createClickVoices } from "../click-voice";
import { buildClickNotes } from "../click-notes";
import { computeCountInPlan, meterAt } from "../count-in";
import { ACCENT_PITCH, CLICK_DURATION_BEATS, NORMAL_PITCH } from "../constants";

/**
 * The headless metronome — a `SonataSession.Effect`, mounted once per playback
 * session so it is always live while a song can play. It renders
 * nothing; it owns the click voice and three audio behaviours:
 *
 *  1. **Count-in provider** — registers the lead-in length (in quarter-beats) the
 *     transport asks for on a deliberate play, computed from the config + the
 *     meter at the live cursor.
 *  2. **Count-in clicks** — when the transport sets `countIn`, it schedules the
 *     lead-in clicks against the audio clock and arms a single audio-clock-driven
 *     completion (a `ConstantSourceNode.onended`) that calls `finishCountIn()` to
 *     begin real playback. No JS timer.
 *  3. **Continuous click track** — when enabled and playing, it feeds a synthetic
 *     click-note list through the engine's `startScheduling` (the SAME scheduler
 *     note playback uses), following the same session timeline — so clicks
 *     inherit the seamless A–B loop wrap, tempo re-timing and driver following.
 *
 * It uses the engine's live `AudioContext` (via `useAudioGraph`) — never its own —
 * because clicks must align sample-accurately to playback, which is anchored on
 * that one clock. The click is routed to `ctx.destination` directly (not the
 * music master gain) so muting the song keeps the click.
 */
export function MetronomeEngine() {
  const graph = useAudioGraph();
  const ctx = graph?.ctx ?? null;

  const { score, timeline, countIn, registerCountIn, finishCountIn } =
    useSession();

  const { continuous, countInBars, volume, accentDownbeat, subdivision } =
    useConfig(metronomeConfig);

  // Imperative per-surface cursor facade (stable). The count-in provider reads
  // the live cursor beat at play time — never as a render input.
  const cursor = useCursorApi();

  // Live mirrors read inside effects/callbacks without listing them as deps, so
  // the registered closures + effects stay stable (mirroring the audio engine).
  const scoreRef = useLatestRef(score);
  const countInBarsRef = useLatestRef(countInBars);
  const volumeRef = useLatestRef(volume);

  // The single click voice, recreated with the AudioContext. Created in the
  // lifecycle effect below (declared first) so the scheduling effects that read
  // it on the same render find it already populated.
  const clickVoicesRef = useRef<InstrumentVoices | null>(null);

  // --- Click voice lifecycle: one voice per AudioContext. --------------------
  // Routed to `ctx.destination` directly (independent of the music master gain);
  // `getVolume` reads the live config volume so the slider takes effect at once.
  useEffect(() => {
    if (!ctx) return;
    const voices = createClickVoices(
      ctx,
      ctx.destination,
      () => volumeRef.current,
    );
    clickVoicesRef.current = voices;
    return () => {
      voices.dispose();
      if (clickVoicesRef.current === voices) clickVoicesRef.current = null;
    };
    // `volumeRef` is a stable latest-ref, so this only re-runs when the context
    // itself is (re)created — exactly when the voice must be rebuilt.
  }, [ctx]);

  // --- Count-in provider registration. --------------------------------------
  // The transport calls this at play time; it returns the lead-in length in
  // quarter-beats (0 = no count-in) for a play from the LIVE cursor, at the meter
  // in force there. Everything it reads is a stable ref/handle, so the registered
  // closure never changes identity (registerCountIn is last-registration-wins).
  useEffect(() => {
    return registerCountIn(() => {
      const barsN = countInBarsRef.current;
      if (barsN <= 0) return 0;
      return computeCountInPlan(scoreRef.current, cursor.getBeat(), barsN)
        .totalQuarters;
    });
  }, [registerCountIn, cursor]);

  // --- Count-in clicks + audio-clock-driven completion. ---------------------
  // Fires whenever the transport arms a `countIn` (cursor parked, isPlaying still
  // false). We reconstruct the click plan from the in-flight `countIn` itself
  // (immune to a mid-lead-in config change), schedule every lead-in click, and
  // arm ONE silent `ConstantSourceNode` whose `onended` (at the lead-in's end, on
  // the audio clock — no timer) starts real playback via `finishCountIn`.
  useEffect(() => {
    if (!countIn || !ctx) return;
    const voices = clickVoicesRef.current;
    if (!voices) return;

    void ctx.resume();

    const startBeat = countIn.startBeat;
    const { numerator, denominator } = meterAt(scoreRef.current, startBeat);
    const quarterPerBeat = 4 / denominator;
    // Bars derived from the lead-in's own length so the per-click accents always
    // match the armed count-in exactly (not the current config value).
    const barsN = Math.max(
      1,
      Math.round(countIn.beats / (quarterPerBeat * numerator)),
    );
    const plan = computeCountInPlan(scoreRef.current, startBeat, barsN);

    // Seconds per quarter-note at the start beat = the lead-in tempo.
    const secPerQuarter =
      beatToSeconds(scoreRef.current, startBeat + 1) -
      beatToSeconds(scoreRef.current, startBeat);

    // Don't schedule into the past if a frame elapsed since the transport stamped
    // the start (the clock only advances after the play-gesture resume).
    const base = Math.max(ctx.currentTime, countIn.startedAtClockSec);

    for (const click of plan.clicks) {
      voices.schedule({
        pitch: click.accent ? ACCENT_PITCH : NORMAL_PITCH,
        velocity: 100,
        when: base + click.offsetQuarters * secPerQuarter,
        duration: CLICK_DURATION_BEATS,
      });
    }

    // Audio-clock completion: a silent constant source stopped at the lead-in's
    // end; its `onended` (fired by the audio thread, not a JS timer) begins play.
    let done = false;
    const node = new ConstantSourceNode(ctx, { offset: 0 });
    node.connect(ctx.destination);
    node.onended = () => {
      done = true;
      finishCountIn();
    };
    node.start();
    node.stop(base + countIn.durationSec);

    return () => {
      // Detach the callback BEFORE stopping so an early stop (seek/stop during the
      // lead-in) can't fire `onended` → `finishCountIn`. Already-scheduled clicks
      // are <60ms transients, so we let them ring out rather than chase them.
      node.onended = null;
      if (!done) node.stop();
      node.disconnect();
    };
  }, [countIn, ctx, finishCountIn]);

  // --- Continuous click track: synthetic notes through the engine scheduler. --
  // The click-note LIST is tempo-INVARIANT (beats only), but `score` identity
  // flips ~60×/s during a tempo drag, so the memo re-derives an identical-content
  // list then. We key the rebuild EFFECT on a cheap signature of the beat
  // structure (`clickNotesKey`) and read the list through a latest-ref, so the
  // schedule rebuilds only on a real beat/accent change — never on a tempo frame
  // (the scheduler re-times itself off the timeline). Mirrors the engine's
  // stable-key discipline.
  const clickNotes = useMemo(
    () => buildClickNotes(score, accentDownbeat, subdivision),
    [score, accentDownbeat, subdivision],
  );
  const clickNotesRef = useLatestRef(clickNotes);
  const clickNotesKey = `${JSON.stringify(score.timeSigMap)}|${
    score.meta.pickupBeats ?? 0
  }|${scoreEndBeat(score)}|${accentDownbeat}|${subdivision}`;

  // Scheduling effect: while the continuous click is on, the click notes follow
  // the session timeline (the scheduler starts, re-times, wraps and silences
  // with it). Mirrors the audio engine's scheduling effect.
  useEffect(() => {
    if (!ctx || !continuous) {
      clickVoicesRef.current?.allOff();
      return;
    }

    // Every click routes to the single click voice (track is ignored; resolve
    // through the live ref so a context swap can't strand a stale voice).
    const resolveVoices = (): InstrumentVoices | undefined =>
      clickVoicesRef.current ?? undefined;

    const handle = startScheduling(
      { notes: clickNotesRef.current, pedalEvents: [] },
      timeline,
      resolveVoices,
      ctx,
      // The clicks keep counting through a repeat's rest: it is one bar at A's
      // meter, so it clicks as a one-bar count-in to every repeat.
      { restSounds: true },
    );

    return () => {
      handle.cancel();
      clickVoicesRef.current?.allOff();
    };
    // `clickNotesKey` flips only on a real beat-structure/accent change (NOT a
    // tempo frame); `timeline` and `clickNotesRef` are stable.
  }, [ctx, continuous, clickNotesKey, timeline, clickNotesRef]);

  return null;
}
