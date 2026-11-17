import { useEffect } from "react";
import { busyElsewhere } from "../../shared/protocol";
import { dispatch, peekState, useMusicSnapshot } from "./store";

export interface MusicSourceHandle {
  /** This source is what the service plays (or holds paused). */
  readonly isCurrent: boolean;
  /** This source is playing now. */
  readonly playing: boolean;
  /** Plays this source — the user asked for it: it takes over from anything else. */
  play(): void;
  /**
   * Plays this source unless other music plays (here or in another browser
   * tab) — for an app's own auto-play, which gives way; only an explicit ask
   * takes over.
   */
  playUnlessBusy(): void;
  /** Pauses this source, if it is what plays. */
  pause(): void;
}

/**
 * An app view's handle on its source of background music, and its presence:
 * while `shown` (the view is on screen as an open app — `useSurfaceShown`),
 * the source counts as in front of the user. When the last view of it leaves,
 * its music pauses — unless the user keeps music across apps.
 */
export function useMusicSource(
  sourceId: string,
  opts: { readonly shown: boolean },
): MusicSourceHandle {
  const { state } = useMusicSnapshot();
  const { shown } = opts;
  useEffect(() => {
    if (!shown) return;
    dispatch({ kind: "shown", sourceId, delta: 1 });
    return () => dispatch({ kind: "shown", sourceId, delta: -1 });
  }, [sourceId, shown]);
  const isCurrent = state.current?.sourceId === sourceId;
  return {
    isCurrent,
    playing: isCurrent && (state.current?.playing ?? false),
    play: () => dispatch({ kind: "play", sourceId }),
    playUnlessBusy: () => {
      if (!busyElsewhere(peekState(), sourceId)) {
        dispatch({ kind: "play", sourceId });
      }
    },
    pause: () => {
      if (peekState().current?.sourceId === sourceId)
        dispatch({ kind: "pause" });
    },
  };
}

/**
 * Music an app plays itself (a Sonata song): while `active` turns on, it
 * interrupts the service's music where nobody sees its app, and every other
 * browser tab's — real music takes over from background ambience.
 */
export function useForegroundMusic(active: boolean): void {
  useEffect(() => {
    if (active) dispatch({ kind: "foreground" });
  }, [active]);
}
