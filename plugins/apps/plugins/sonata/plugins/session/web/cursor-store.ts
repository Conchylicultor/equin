import { useMemo, type DependencyList } from "react";
import {
  samePosition,
  songPosition,
  type PlayPosition,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  defineScopedStore,
  type ScopedStore,
} from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";

/**
 * The playback cursor (playhead position in quarter-note beats) as a
 * PER-SURFACE scoped store rather than a module singleton.
 *
 * The transport advances the cursor ~60×/sec from a `requestAnimationFrame`
 * loop. Holding it in the session context would mint a new context object every
 * frame and re-render EVERY `useSession()` consumer — including ones that only
 * forward the cursor to an imperative handle (the Pixi piano-roll scene, the
 * audio scheduler) or whose output changes only at region boundaries (the
 * key/chord HUD). Keeping it in an external store lets each consumer opt into
 * exactly the read path it needs and leaves the context value identity-stable
 * during playback (so non-readers stop re-rendering entirely).
 *
 * Scoping it to the `<CursorStoreProvider>` (mounted by the player scope,
 * wrapping `PlaybackSession`) gives every Sonata surface its own isolated cursor — desktop
 * multi-window / keep-alive tabs mount several surfaces at once, and a module
 * singleton would tear (playback bleeding between windows).
 *
 * Two read paths, mirroring the scoped-store primitive this builds on:
 *  - {@link useCursorApi} — imperative facade for in-subtree readers (rAF loops,
 *    synchronous reads). Drives a scene handle or DOM transform with ZERO React
 *    renders.
 *  - {@link useCursorSelector} — derived-with-bailout; re-renders only when the
 *    selected value changes (for frame-invariant HUD/readout consumers).
 */

/**
 * The cursor holds the transport's whole {@link PlayPosition}: the score
 * `beat`, plus — inside an A–B loop — the rest still to go before it sounds and
 * whether this is a repeat pass. Most readers want only `beat`; a reader of
 * what is BEING PLAYED also reads `rest`, and a display that unrolls the loop
 * ahead places the cursor from the whole position.
 */
type CursorState = PlayPosition;
const cursorStore = defineScopedStore<CursorState>(songPosition(0));

export const CursorStoreProvider = cursorStore.Provider;
export type CursorStore = ScopedStore<CursorState>;

/**
 * Typed imperative facade over the per-surface cursor store. Carries the `seek`
 * flag through scoped-store's `meta`.
 *
 * `seek: true` marks a jump (seek / scrub / score reset) as opposed to a smooth
 * playback advance. Imperative onset-driven consumers (the piano-roll scene)
 * re-anchor on a seek instead of firing every onset between the old and new
 * position — navigation must not spray note-strike FX. It's threaded through the
 * subscription callback rather than inferred, because the synchronous store
 * write reaches imperative subscribers before React commits anything.
 *
 * A write early-returns on an unchanged position (unless it's a seek) so the
 * snapshot stays referentially stable while the store hasn't moved — required
 * for the `useSyncExternalStore` tearing check not to loop.
 */
export interface CursorApi {
  /** The score beat (`getPosition().beat`). */
  getBeat(): number;
  /** The whole play position (see {@link PlayPosition}). */
  getPosition(): PlayPosition;
  /** Move to `beat` on the song's own pass (no rest, no repeat) — a seek, a
   *  scrub step, a reset. */
  setBeat(beat: number, opts?: { seek?: boolean }): void;
  /** Move to a full play position — the transport's loop-aware advance. */
  setPosition(position: PlayPosition, opts?: { seek?: boolean }): void;
  subscribe(cb: (seek: boolean) => void): () => void;
}

/** Build the imperative cursor facade for a given scoped store instance. */
export function cursorApiFor(store: CursorStore): CursorApi {
  const setPosition = (next: PlayPosition, opts?: { seek?: boolean }) =>
    store.setState((p) => (samePosition(p, next) && !opts?.seek ? p : next), {
      meta: { seek: !!opts?.seek },
    });
  return {
    getBeat: () => store.getState().beat,
    getPosition: () => store.getState(),
    setBeat: (beat, opts) => setPosition(songPosition(beat), opts),
    setPosition,
    subscribe: (cb) =>
      store.subscribe((meta) =>
        cb(Boolean((meta as { seek?: boolean } | undefined)?.seek)),
      ),
  };
}

/** Imperative cursor facade for in-subtree readers (rAF loops, synchronous reads). */
export function useCursorApi(): CursorApi {
  const store = cursorStore.useStoreApi();
  return useMemo(() => cursorApiFor(store), [store]);
}

/**
 * Derived cursor read with re-render bailout — a hand-rolled
 * `useSyncExternalStoreWithSelector`. Re-renders the caller ONLY when
 * `selector(beat)` changes per `isEqual` (default `Object.is`); a value/reference
 * that's stable within a region — a `KeySignature` from a memoized list, a
 * constant BPM number, a chord `Annotation` found in a stable array — bails out,
 * so the component never reconciles mid-region even as the cursor advances.
 *
 * The selector also receives the whole {@link PlayPosition} as its second
 * argument, for a reader that must tell a loop's rest from playing (a key lit
 * at `beat` is not sounding while `position.rest > 0`).
 *
 * `deps` invalidate the cache exactly like `useMemo`'s deps: when the selector
 * closes over new data (a new score, tempoScale, …) the same beat can map to a
 * new value, so the cache must be dropped. Pass everything the selector reads
 * besides `beat`. For selectors that build a FRESH object each call (so `Object.is`
 * can never match), pass an `isEqual` that compares by value.
 */
export function useCursorSelector<T>(
  selector: (beat: number, position: PlayPosition) => T,
  deps: DependencyList,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return cursorStore.useSelector((s) => selector(s.beat, s), deps, isEqual);
}
