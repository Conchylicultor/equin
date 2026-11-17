import { rowOrStale } from "@plugins/network/plugins/live/web";
import type { BackgroundMusicPlayerProps } from "@plugins/music/plugins/background/web";
import {
  sonataSongLink,
  useCurrentSong,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import {
  useBackgroundPlaybackPlayer,
  useBackgroundPlaybackLabel,
  useHasBackgroundPlayback,
  usePlaybackInstanceKey,
  usePublishPlaybackLabel,
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
  return useBackgroundPlaybackLabel()?.title ?? "";
}

/** The background song's page — the player pane — for the music button's now-playing tile. */
export function useSonataBackgroundHref(): string {
  return useBackgroundPlaybackLabel()?.href ?? sonataApp.basePath;
}

/** Sonata has music to offer only while a song plays on in the background. */
export function useSonataBackgroundAvailable(): boolean {
  return useHasBackgroundPlayback();
}

/**
 * Names the playback instance's song for the music button — a
 * `Sonata.PlaybackEffect`, so it follows the song when the page is gone: its
 * title (as last seen while its row reloads; empty while none was ever read)
 * and its page, the player pane.
 */
export function PublishSongLabel(): null {
  const key = usePlaybackInstanceKey();
  const song = useCurrentSong();
  const { currentSongId } = useSonataApp();
  usePublishPlaybackLabel(
    key,
    rowOrStale(song)?.title ?? "",
    currentSongId === null ? sonataApp.basePath : sonataSongLink(currentSongId),
  );
  return null;
}
