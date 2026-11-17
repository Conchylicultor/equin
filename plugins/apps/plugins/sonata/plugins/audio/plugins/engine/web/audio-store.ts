import { useMemo } from "react";
import { defineScopedStore } from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";

/**
 * A per-surface reactive store sharing the small slice of audio state that
 * crosses the engine ↔ control boundary.
 *
 * The Web Audio graph lives in the headless, always-mounted `AudioEngine`
 * (a `SonataSession.Effect`) so no piece of mountable UI can tear the `AudioContext`
 * down. The `VolumeControl` (a player-header widget) is therefore decoupled
 * from the graph: the slider *writes* `volume` here and the engine reads it to
 * drive master gain; the engine *writes* `status` / `loadError` here. Either
 * component can mount, unmount, or remount independently.
 *
 * State is scoped per `<AudioStoreProvider>` (folded above both consumers via the
 * `SonataSession.Provider` wrapper slot) so two open Sonata surfaces have
 * independent volume/status — a module-level singleton would bleed across them.
 */

export type AudioStatus = "empty" | "loading" | "ready";

/**
 * The shared Web Audio graph handle the engine owns and publishes here. The
 * engine is the SOLE owner of the `AudioContext` (its lifecycle must not be tied
 * to mountable UI; see this plugin's `CLAUDE.md`); it merely publishes the live
 * ctx + master gain so sibling per-surface effects in other slot branches — e.g.
 * the metronome (reads `ctx`) and the live player (routes voices into `master`,
 * so the master-volume slider governs hand-played notes too) — can share the
 * same clock and output bus playback is anchored against. `null` until the
 * engine's mount effect has created the context.
 */
export interface AudioGraph {
  ctx: AudioContext;
  master: GainNode;
}

export interface AudioState {
  /** Master volume 0..1, driven by the panel slider. */
  volume: number;
  /** Aggregate sample-load status of the in-use instruments. */
  status: AudioStatus;
  /** Latest instrument load failure message, or null. */
  loadError: string | null;
  /** Level to restore on un-mute: the most recent non-zero volume. Kept in
   *  state (per-surface) so a click-to-mute survives the control remounting. */
  lastNonZeroVolume: number;
  /** The engine's live audio graph (ctx), or null before it mounts. Published by
   *  the engine; read by sibling audio effects (e.g. the metronome). */
  graph: AudioGraph | null;
}

export const DEFAULT_VOLUME = 0.8;

const audioStore = defineScopedStore<AudioState>({
  volume: DEFAULT_VOLUME,
  status: "empty",
  loadError: null,
  lastNonZeroVolume: DEFAULT_VOLUME,
  graph: null,
});

export const AudioStoreProvider = audioStore.Provider;
export const audioStoreRelay = audioStore.relay;

/** Reactive read of the full audio state. */
export function useAudioState(): AudioState {
  return audioStore.useStore();
}

/**
 * Reactive read of the engine's shared audio graph (the live `AudioContext`), or
 * null until the engine has mounted it. Sibling audio effects (the metronome)
 * use it to schedule events on the same clock playback is anchored against.
 */
export function useAudioGraph(): AudioGraph | null {
  return audioStore.useStore().graph;
}

/**
 * Imperative audio-state writers for in-subtree components (the engine effect
 * and the volume control). Stable (memoized on the store handle) so callers can
 * safely list it in effect deps.
 */
export function useAudioControls() {
  const store = audioStore.useStoreApi();
  return useMemo(
    () => ({
      /** Control → engine: set the master volume. */
      setVolume: (volume: number) =>
        store.setState((s) => ({
          ...s,
          volume,
          lastNonZeroVolume: volume > 0 ? volume : s.lastNonZeroVolume,
        })),
      /** Mute (volume → 0) or restore the pre-mute level. Dragging to 0 then
       *  toggling restores the last audible level; toggling an already-0 level
       *  un-mutes to `lastNonZeroVolume`. */
      toggleMute: () =>
        store.setState((s) => ({
          ...s,
          volume: s.volume > 0 ? 0 : s.lastNonZeroVolume,
        })),
      /** Engine → panel: publish the aggregate load status. */
      setStatus: (status: AudioStatus) =>
        store.setState((s) => ({ ...s, status })),
      /** Engine → panel: publish (or clear) the latest load error. */
      setLoadError: (loadError: string | null) =>
        store.setState((s) => ({ ...s, loadError })),
      /** Engine → siblings: publish (or clear, on teardown) the live audio graph. */
      setGraph: (graph: AudioGraph | null) =>
        store.setState((s) => ({ ...s, graph })),
    }),
    [store],
  );
}
