import { useEffect, useMemo, useState } from "react";
import {
  appIconFile,
  getAppIconPng,
} from "@plugins/apps-core/plugins/app-manifest/core";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import { useCurrentSong } from "@plugins/apps/plugins/sonata/plugins/library/web";
import {
  buildTempoIndex,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { assetPath } from "@plugins/infra/plugins/endpoints/core";
import { useMediaSession } from "@plugins/media/plugins/media-session/web";
import { rowOrStale } from "@plugins/network/plugins/live/web";

const ARTWORK = [
  {
    asset: assetPath(getAppIconPng, {
      appId: sonataApp.id,
      file: appIconFile(512),
    }),
    sizes: "512x512",
    type: "image/png",
  },
] as const;

/**
 * The playing song in the browser's media session (Chrome's media controls,
 * the OS's Now Playing and media keys): its title, a scrubber over the
 * tempo-scaled song, and play / pause / seek driving the session. A
 * `Sonata.PlaybackEffect`, so it follows the song when it plays on with no
 * Sonata page shown — the service's Sonata source leaves the session to it.
 */
export function SonataNowPlaying(): null {
  const session = useSession();
  const { score, isPlaying, timeline, play, stop, seekTo } = session;
  const cursor = useCursorApi();
  const song = useCurrentSong();
  const title = rowOrStale(song)?.title ?? "";

  const tempo = useMemo(() => buildTempoIndex(score), [score]);
  const endBeat = scoreEndBeat(score);
  const duration = endBeat > 0 ? tempo.beatToSeconds(endBeat) : 0;

  // Where the song is, in seconds — read at each discontinuity only (play,
  // pause, a seek, a re-timing): between them the browser extrapolates.
  const [position, setPosition] = useState(0);
  useEffect(() => {
    const read = () =>
      setPosition(Math.max(0, tempo.beatToSeconds(cursor.getBeat())));
    read();
    const offTimeline = timeline.subscribe(read);
    const offCursor = cursor.subscribe((seek) => {
      if (seek) read();
    });
    return () => {
      offTimeline();
      offCursor();
    };
  }, [tempo, cursor, timeline, isPlaying]);

  useMediaSession(
    endBeat > 0
      ? {
          title: title === "" ? sonataApp.name : title,
          artist: sonataApp.name,
          artwork: ARTWORK,
          playing: isPlaying,
          position: { duration, position },
          actions: {
            play,
            pause: stop,
            seekto: (seconds) => seekTo(tempo.secondsToBeat(seconds)),
            seekbackward: (offset) =>
              seekTo(
                tempo.secondsToBeat(
                  Math.max(0, tempo.beatToSeconds(cursor.getBeat()) - offset),
                ),
              ),
            seekforward: (offset) =>
              seekTo(
                tempo.secondsToBeat(
                  tempo.beatToSeconds(cursor.getBeat()) + offset,
                ),
              ),
          },
        }
      : null,
  );
  return null;
}
