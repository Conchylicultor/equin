import { useCallback, useState, useSyncExternalStore } from "react";
import {
  YouTubePlayerControllerImpl,
  type YouTubePlayerController,
  type YouTubePlayerState,
} from "./controller";

/**
 * One player's controller, stable for the life of the calling component. Pass
 * it to `<YouTubePlayer controller>` to bind it to an iframe, and to the
 * buttons and readouts that drive or watch that player.
 */
export function useYouTubePlayer(): YouTubePlayerController {
  const [controller] = useState(() => new YouTubePlayerControllerImpl());
  return controller;
}

/** The player's state (`loading` / `ready` / `error`), re-rendering on change. */
export function useYouTubePlayerState(
  controller: YouTubePlayerController,
): YouTubePlayerState {
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
}

const noSubscription = () => () => {};

/**
 * The playhead in seconds, read once per animation frame while the video plays
 * and `active` is true — animation, not change detection. Only the component
 * calling this re-renders on each frame, so put it on the smallest element
 * that moves (the playhead line), not on the screen.
 *
 * `null` while `active` is false or the player is not ready. Paused, it holds
 * the time it stopped at.
 */
export function useYouTubePlayhead(
  controller: YouTubePlayerController,
  active: boolean,
): number | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      active ? controller.subscribePlayhead(listener) : noSubscription(),
    [controller, active],
  );
  const getSnapshot = useCallback(
    () => (active ? controller.getPlayhead() : null),
    [controller, active],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
