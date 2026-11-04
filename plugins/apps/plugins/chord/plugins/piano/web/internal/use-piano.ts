import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  SonataAudio,
  useInstrumentAssets,
  type InstrumentVoices,
} from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";

/** How long a struck chord rings, in seconds. */
const RING_SECONDS = 1.4;
/** The gap between two notes of a chord, low to high: a strum, not a block. */
const STRUM_SECONDS = 0.018;
/** Scheduling slack after "now", so the first note is never in the past. */
const LEAD_SECONDS = 0.03;
/** MIDI velocity of the bass note; the upper notes are a little softer. */
const BASS_VELOCITY = 84;
const UPPER_VELOCITY = 70;

/** How fast a volume change glides, in seconds: quick, but never a click. */
const GAIN_GLIDE_SECONDS = 0.03;

/** The Chord app's piano: one AudioContext, one voice set and its level, for this screen. */
type PianoGraph = {
  ctx: AudioContext;
  voices: InstrumentVoices;
  gain: GainNode;
};

/** What the screen can do with its piano. */
export type Piano = {
  /**
   * Strike these pitches, cutting whatever was sounding. `ringSeconds` is how
   * long they hold (a chord following the song holds for its box). Rejects when
   * the instrument is missing or its samples fail to load.
   */
  play: (
    pitches: readonly number[],
    opts?: { ringSeconds?: number },
  ) => Promise<void>;
  /** Cut everything sounding now — the song paused, so its piano stops too. */
  silence: () => void;
};

/**
 * Sonata's default instrument (the sampled grand), played on this screen's own
 * `AudioContext`.
 *
 * Lifecycle (the first consumer outside Sonata, so it is spelled out):
 * - **Created on the first chord played**, inside the click that asked for it.
 *   So the samples download only when a chord is first played, and the context
 *   is born inside a user gesture, which is what lets it start running. (A
 *   chord struck by the piano following the song comes from the playhead, not
 *   a click — but the song only plays after the learner pressed Play, and that
 *   earlier activation is what lets the context run.)
 * - **One per screen**: later chords reuse the same context and voices, and the
 *   screen hands this ONE instance to everything that sounds — the chord
 *   buttons, the answer boxes, and the keyboard's own playable keys. A second
 *   `usePiano()` would open a second context beside it. Each new sound cuts the
 *   one before it (`allOff`), so nothing piles up.
 * - **Disposed on unmount**: the voices, then the context.
 * - **One level for everything it plays** (`volume`, 0–1): the chords
 *   following the song and every chord or key the learner strikes.
 *
 * The instrument is read generically from `SonataAudio.Instrument` (the one
 * contribution marked `default`), never by name. A failure — no default
 * instrument, or samples that fail to load — rejects the returned promise.
 */
export function usePiano(volume: number): Piano {
  const instruments = SonataAudio.Instrument.useContributions();
  const instrumentsRef = useLatestRef(instruments);
  const assetsRef = useLatestRef(useInstrumentAssets());
  const graphRef = useRef<PianoGraph | null>(null);
  const volumeRef = useLatestRef(volume);

  // The level (0–1) follows the setting, gliding rather than jumping.
  useEffect(() => {
    const graph = graphRef.current;
    if (graph === null) return;
    graph.gain.gain.setTargetAtTime(
      volume,
      graph.ctx.currentTime,
      GAIN_GLIDE_SECONDS,
    );
  }, [volume]);

  useEffect(
    () => () => {
      const graph = graphRef.current;
      graphRef.current = null;
      if (graph === null) return;
      graph.voices.dispose();
      if (graph.ctx.state !== "closed") void graph.ctx.close();
    },
    [],
  );

  const play = useCallback(
    async (pitches: readonly number[], opts?: { ringSeconds?: number }) => {
      let graph = graphRef.current;
      if (graph === null) {
        const instrument = instrumentsRef.current.find((i) => i.default);
        if (instrument === undefined) {
          throw new Error(
            "No default instrument is registered on SonataAudio.Instrument: the piano cannot play",
          );
        }
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        gain.gain.value = volumeRef.current;
        gain.connect(ctx.destination);
        graph = {
          ctx,
          voices: instrument.createVoices(ctx, gain, assetsRef.current),
          gain,
        };
        graphRef.current = graph;
      }
      const { ctx, voices } = graph;
      // A context created or suspended outside a gesture starts suspended.
      if (ctx.state === "suspended") await ctx.resume();
      await voices.loaded;
      // Unmounted while the samples loaded: nothing left to play into.
      if (graphRef.current !== graph) return;
      voices.allOff();
      const start = ctx.currentTime + LEAD_SECONDS;
      pitches.forEach((pitch, i) => {
        voices.schedule({
          pitch,
          velocity: i === 0 ? BASS_VELOCITY : UPPER_VELOCITY,
          when: start + i * STRUM_SECONDS,
          duration: opts?.ringSeconds ?? RING_SECONDS,
        });
      });
    },
    [instrumentsRef, volumeRef],
  );
  const silence = useCallback(() => graphRef.current?.voices.allOff(), []);
  return useMemo(() => ({ play, silence }), [play, silence]);
}
