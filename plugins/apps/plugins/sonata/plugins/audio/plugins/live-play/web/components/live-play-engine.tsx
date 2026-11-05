import { useEffect, useMemo, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  SonataAudio,
  useInstrumentAssets,
  type InstrumentVoices,
} from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import { useAudioGraph } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web";
import { useLivePlayControls, type LivePlayApi } from "../live-store";

const DEFAULT_VELOCITY = 90;

/**
 * The headless Sonata live interactive player — a `SonataSession.Effect`,
 * mounted once per playback session and therefore always mounted while a song
 * can play; it renders nothing.
 *
 * It turns hand-played key presses (from the playable keyboard) into sustaining
 * note-on/note-off voices, REUSING the engine's shared graph: it routes voices
 * through the published `master` gain (so the master-volume slider governs
 * hand-played notes too) on the same `AudioContext` playback is anchored against
 * — never a second context. The timbre is the DEFAULT instrument, resolved
 * generically via the `SonataAudio.Instrument` collection API (never naming a
 * contributor).
 *
 * A key pressed before the instrument's samples are in is never dropped: it
 * waits for `voices.loaded` and sounds then (released at once if the key was
 * let go meanwhile, so a quick tap still answers) — the first press of a
 * session lands in that window whenever it beats the load, on a cold cache
 * (samples downloading) as on a warm one (still decoding).
 *
 * The published `LivePlayApi` is a STABLE object whose methods read refs, so the
 * keyboard can depend on it without churning. The graph + resolved instrument
 * are mirrored through `useLatestRef` and read live inside those methods.
 */
export function LivePlayEngine() {
  const graph = useAudioGraph();
  const graphRef = useLatestRef(graph);

  // Default instrument, resolved generically (collection-clean: never names the
  // piano plugin). Mirrored via latest-ref so the stable api reads it live.
  const instruments = SonataAudio.Instrument.useContributions();
  const defaultInstrument = useMemo(
    () => instruments.find((i) => i.default) ?? instruments[0],
    [instruments],
  );
  const instrumentRef = useLatestRef(defaultInstrument);
  const assetsRef = useLatestRef(useInstrumentAssets());

  const voicesRef = useRef<InstrumentVoices | null>(null);
  const heldRef = useRef<Map<number, () => void>>(new Map());
  /** Whether `voicesRef.current`'s samples are in (its `loaded` resolved). */
  const readyRef = useRef(false);
  /** Presses waiting for the samples: pitch → velocity, and whether it was let go. */
  const pendingRef = useRef<
    Map<number, { velocity: number; released: boolean }>
  >(new Map());

  const { setApi } = useLivePlayControls();

  // The published API: one stable object built once, whose methods read refs so
  // they always see the latest graph + instrument without re-identifying.
  const api = useMemo<LivePlayApi>(() => {
    const ensureVoices = () => {
      if (voicesRef.current) return;
      const graphNow = graphRef.current;
      const inst = instrumentRef.current;
      if (!graphNow || !inst) return;
      const voices = inst.createVoices(
        graphNow.ctx,
        graphNow.master,
        assetsRef.current,
      );
      voicesRef.current = voices;
      readyRef.current = false;
      // Start the sample load; surface a rejected load loudly (async throw →
      // unhandled rejection) rather than leaving it floating or silenced.
      void voices.loaded.then(
        () => {
          // Disposed or replaced meanwhile: its presses went with it.
          if (voicesRef.current !== voices) return;
          readyRef.current = true;
          // Taken off the queue first, so a throwing play leaves nothing stale.
          const pending = [...pendingRef.current];
          pendingRef.current.clear();
          for (const [pitch, { velocity, released }] of pending) {
            heldRef.current.delete(pitch);
            const stop = voices.play?.(pitch, velocity);
            if (!stop) continue;
            if (released) stop();
            else heldRef.current.set(pitch, stop);
          }
        },
        (err: unknown) => {
          if (voicesRef.current === voices) pendingRef.current.clear();
          throw err instanceof Error ? err : new Error(String(err));
        },
      );
    };

    return {
      warmup() {
        ensureVoices();
      },
      press(pitch: number, velocity: number = DEFAULT_VELOCITY) {
        const graphNow = graphRef.current;
        if (graphNow) void graphNow.ctx.resume();
        ensureVoices();
        // Retrigger: release an already-held voice for this pitch first.
        const prev = heldRef.current.get(pitch);
        if (prev) {
          prev();
          heldRef.current.delete(pitch);
        }
        if (voicesRef.current && !readyRef.current) {
          // Samples not in yet: sound it once they are (see the doc above).
          const pending = { velocity, released: false };
          pendingRef.current.set(pitch, pending);
          heldRef.current.set(pitch, () => {
            pending.released = true;
          });
          return;
        }
        const stop = voicesRef.current?.play?.(pitch, velocity);
        if (stop) heldRef.current.set(pitch, stop);
      },
      release(pitch: number) {
        const stop = heldRef.current.get(pitch);
        if (stop) {
          stop();
          heldRef.current.delete(pitch);
        }
      },
      releaseAll() {
        // A panic is no quick tap: what still waits for the samples is dropped.
        pendingRef.current.clear();
        for (const stop of heldRef.current.values()) stop();
        heldRef.current.clear();
      },
    };
    // Built once: every value it closes over is a stable latest-ref.
  }, [graphRef, instrumentRef]);

  // Rebuild voices when the AudioContext changes (a fresh context must rebuild
  // the voice manager): release held notes + dispose the old voices so the next
  // press lazily recreates them against the new ctx.
  const ctx = graph?.ctx;
  useEffect(() => {
    // Capture the stable held-voices map for the cleanup (the Map identity never
    // changes; reading the ref directly in cleanup trips react-hooks/refs).
    const held = heldRef.current;
    const pending = pendingRef.current;
    return () => {
      for (const stop of held.values()) stop();
      held.clear();
      pending.clear();
      voicesRef.current?.dispose();
      voicesRef.current = null;
    };
  }, [ctx]);

  // Publish the stable api on mount; retract + tear down on unmount.
  useEffect(() => {
    setApi(api);
    const held = heldRef.current;
    const pending = pendingRef.current;
    return () => {
      for (const stop of held.values()) stop();
      held.clear();
      pending.clear();
      voicesRef.current?.dispose();
      voicesRef.current = null;
      setApi(null);
    };
  }, [api, setApi]);

  return null;
}
