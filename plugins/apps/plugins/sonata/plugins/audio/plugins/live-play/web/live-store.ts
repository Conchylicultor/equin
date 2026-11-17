import { useMemo } from "react";
import { defineScopedStore } from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";

/**
 * Per-surface store publishing the live interactive player's imperative API.
 *
 * Modeled on the engine's `audio-store`: the headless `LivePlayEngine` effect
 * builds one stable `LivePlayApi` and publishes it here; the playable keyboard
 * (a sibling in a different slot branch) reads it via `useLivePlay()`. Scoping
 * to the `<Provider>` (folded above the whole Sonata subtree via the
 * `SonataSession.Provider` wrapper slot) keeps two open Sonata surfaces playing
 * independently instead of sharing one module-level singleton.
 */
export interface LivePlayApi {
  /** Create voices + start the sample load ahead of the first press. */
  warmup(): void;
  /** Note-on: start (or retrigger) a sustaining voice for `pitch`. */
  press(pitch: number, velocity?: number): void;
  /** Note-off: release the sustaining voice for `pitch`. */
  release(pitch: number): void;
  /** Panic / cleanup: release every currently-held voice. */
  releaseAll(): void;
}

interface LiveState {
  /** The engine's published API, or null before the effect mounts. */
  api: LivePlayApi | null;
}

const store = defineScopedStore<LiveState>({ api: null });

export const LivePlayStoreProvider = store.Provider;
export const livePlayStoreRelay = store.relay;

/** Reactive read of the live player's API, or null until the engine mounts it. */
export function useLivePlay(): LivePlayApi | null {
  return store.useStore().api;
}

/**
 * Imperative writer for the engine effect to publish (or clear, on teardown)
 * its API. Stable (memoized on the store handle) so it can sit in effect deps.
 */
export function useLivePlayControls() {
  const api = store.useStoreApi();
  return useMemo(
    () => ({
      setApi: (a: LivePlayApi | null) =>
        api.setState((s) => ({ ...s, api: a })),
    }),
    [api],
  );
}
