import { useEffect, useRef } from "react";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useLibrarySongLoad } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { recordPlay } from "../../shared/endpoints";

/**
 * Headless: records a play when the loaded song's playback first starts.
 * Mounted via `Sonata.Effect` (inside the app's player scope).
 *
 * Counts once per *load* (the song and its load read as one value): pause→resume
 * within one load does not re-count, nor does leaving the player and coming back
 * to the song still loaded; loading it again — even the same one — re-arms it.
 */
export function RecordPlayObserver() {
  const fetchEndpoint = useFetchEndpoint();
  const song = useLibrarySongLoad();
  const { isPlaying } = useSession();
  const prevPlaying = useRef(false);
  const recordedLoad = useRef<number | null>(null);

  useEffect(() => {
    const started = !prevPlaying.current && isPlaying;
    prevPlaying.current = isPlaying;
    if (
      started &&
      song.kind === "library" &&
      recordedLoad.current !== song.load
    ) {
      recordedLoad.current = song.load;
      void fetchEndpoint(recordPlay, { id: song.songId });
    }
  }, [isPlaying, song, fetchEndpoint]);

  return null;
}
