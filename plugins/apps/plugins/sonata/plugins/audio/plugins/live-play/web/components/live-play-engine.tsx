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
      // Start the sample load; surface a rejected load loudly (async throw →
      // unhandled rejection) rather than leaving it floating or silenced.
      void voices.loaded.then(
        () => {},
        (err: unknown) => {
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
    return () => {
      for (const stop of held.values()) stop();
      held.clear();
      voicesRef.current?.dispose();
      voicesRef.current = null;
    };
  }, [ctx]);

  // Publish the stable api on mount; retract + tear down on unmount.
  useEffect(() => {
    setApi(api);
    const held = heldRef.current;
    return () => {
      for (const stop of held.values()) stop();
      held.clear();
      voicesRef.current?.dispose();
      voicesRef.current = null;
      setApi(null);
    };
  }, [api, setApi]);

  return null;
}
