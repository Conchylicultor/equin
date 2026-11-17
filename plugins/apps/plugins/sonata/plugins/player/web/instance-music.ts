import { useEffect, useSyncExternalStore } from "react";
import {
  instancesSnapshot,
  publishTitle,
  setBackgroundPlaying,
  subscribeInstances,
  type InstancesSnapshot,
} from "./internal/instances";

function useInstances(): InstancesSnapshot {
  return useSyncExternalStore(
    subscribeInstances,
    instancesSnapshot,
    instancesSnapshot,
  );
}

/** Whether instance `key` is the page's background instance (`null`: a local scope, never). */
export function useIsBackground(key: string | null): boolean {
  const { background } = useInstances();
  return key !== null && background === key;
}

/** Whether a Sonata song plays on with no view of it — what the music service can offer of Sonata. */
export function useHasBackgroundPlayback(): boolean {
  return useInstances().background !== null;
}

/** The title of the song playing on in the background ("" while none, or before its app named it). */
export function useBackgroundPlaybackTitle(): string {
  const { background, titles } = useInstances();
  return background === null ? "" : (titles.get(background) ?? "");
}

/**
 * The music service's player for Sonata (`BackgroundMusic.Source`'s
 * `usePlayer`): plays or pauses the background instance as the service says.
 * The instance plays already when the service adopts it, so only a change is
 * applied — an idle warm-up mount does nothing.
 */
export function useBackgroundPlaybackPlayer(playing: boolean): void {
  useEffect(() => setBackgroundPlaying(playing), [playing]);
}

/**
 * Names the song of the playback instance the caller runs in (an app's
 * `effects`, `usePlaybackInstanceKey`) for the music button. A no-op in a
 * local scope.
 */
export function usePublishPlaybackTitle(
  key: string | null,
  title: string,
): void {
  useEffect(() => {
    if (key !== null) publishTitle(key, title);
  }, [key, title]);
}
