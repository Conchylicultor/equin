import { useEffect } from "react";
import { useSurfaceShowsAppsSideBySide } from "@plugins/apps-core/plugins/tabs/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
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
  /** Resumes this source, if it is what the service holds paused. */
  resume(): void;
  /**
   * This source's music, playing in its app's view, outlives the view (the
   * view went away while it played): it becomes what the service plays — if
   * the user keeps music across apps. Answers whether it did; when not, the
   * music ends with its view.
   */
  adopt(): boolean;
  /**
   * This source leaves the service without being paused — its app plays it in
   * front again (a view of it came back). A no-op unless it is current.
   */
  release(): void;
}

/**
 * An app view's handle on its source of background music, and its presence:
 * while `shown` (the view is on screen as an open app — `useSurfaceShown`),
 * the source counts as in front of the user. When the last view of it leaves,
 * its music pauses — unless the user keeps music across apps, in a surface
 * that shows one app at a time. On the desktop (apps side by side) a view
 * leaving is its window closing: its music ends with it, kept across apps or
 * not.
 */
export function useMusicSource(
  sourceId: string,
  opts: { readonly shown: boolean },
): MusicSourceHandle {
  const { state } = useMusicSnapshot();
  const { shown } = opts;
  // Leaving closes the app when the mode the view last rendered in shows apps
  // side by side (a desktop window closing).
  const sideBySide = useSurfaceShowsAppsSideBySide();
  const leave = useEventCallback((id: string) =>
    dispatch({ kind: "shown", sourceId: id, delta: -1, closesApp: sideBySide }),
  );
  useEffect(() => {
    if (!shown) return;
    dispatch({ kind: "shown", sourceId, delta: 1, closesApp: false });
    return () => leave(sourceId);
  }, [sourceId, shown, leave]);
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
    resume: () => {
      if (peekState().current?.sourceId === sourceId)
        dispatch({ kind: "resume" });
    },
    adopt: () => {
      dispatch({ kind: "adopt", sourceId, closesApp: sideBySide });
      const now = peekState().current;
      return now?.sourceId === sourceId && now.playing;
    },
    release: () => {
      if (peekState().current?.sourceId === sourceId)
        dispatch({ kind: "stop" });
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
