import { rowOrStale } from "@plugins/network/plugins/live/web";
import type { BackgroundMusicPlayerProps } from "@plugins/music/plugins/background/web";
import { useCurrentSong } from "@plugins/apps/plugins/sonata/plugins/library/web";
import {
  useBackgroundPlaybackPlayer,
  useBackgroundPlaybackTitle,
  useHasBackgroundPlayback,
  usePlaybackInstanceKey,
  usePublishPlaybackTitle,
} from "@plugins/apps/plugins/sonata/plugins/player/web";

/**
 * The music service's player for Sonata: the song playing on in the
 * background, played or paused as the service says. Its own volume (the
 * player's master) applies — the source declares `ownVolume`, so `gain` is
 * not used.
 */
export function useSonataBackgroundPlayer({
  playing,
}: BackgroundMusicPlayerProps): void {
  useBackgroundPlaybackPlayer(playing);
}

/** The background song's title, for the music button. */
export function useSonataBackgroundTitle(): string {
  return useBackgroundPlaybackTitle();
}

/** Sonata has music to offer only while a song plays on in the background. */
export function useSonataBackgroundAvailable(): boolean {
  return useHasBackgroundPlayback();
}

/**
 * Names the playback instance's song for the music button — a
 * `Sonata.PlaybackEffect`, so it follows the song when the page is gone. The
 * title as last seen while its row reloads; empty while none was ever read.
 */
export function PublishSongTitle(): null {
  const key = usePlaybackInstanceKey();
  const song = useCurrentSong();
  usePublishPlaybackTitle(key, rowOrStale(song)?.title ?? "");
  return null;
}
