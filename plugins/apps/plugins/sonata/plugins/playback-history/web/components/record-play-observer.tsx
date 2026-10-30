import { useEffect, useRef } from "react";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { recordPlay } from "../../shared/endpoints";

/**
 * Headless: records a play when the loaded song's playback first starts.
 * Mounted via `Sonata.Effect` (inside the app's player scope).
 *
 * Counts once per *load* (keyed on `songLoadEpoch`): pause→resume within one
 * load does not re-count, nor does leaving the player and coming back to the
 * song still loaded; loading it again — even the same one — re-arms it.
 */
export function RecordPlayObserver() {
  const fetchEndpoint = useFetchEndpoint();
  const { currentSongId, songLoadEpoch } = useSonataApp();
  const { isPlaying } = useSession();
  const prevPlaying = useRef(false);
  const recordedEpoch = useRef<number | null>(null);

  useEffect(() => {
    const started = !prevPlaying.current && isPlaying;
    prevPlaying.current = isPlaying;
    if (started && currentSongId && recordedEpoch.current !== songLoadEpoch) {
      recordedEpoch.current = songLoadEpoch;
      void fetchEndpoint(recordPlay, { id: currentSongId });
    }
  }, [isPlaying, currentSongId, songLoadEpoch, fetchEndpoint]);

  return null;
}
