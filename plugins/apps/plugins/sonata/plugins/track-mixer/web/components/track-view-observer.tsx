import { useEffect } from "react";
import {
  useFailSongSetting,
  useMountedSongId,
  useWriteSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { trackViewScope, trackViews } from "../../shared/resources";
import { trackViewSetting } from "../track-view-setting";

/**
 * Headless observer of the `trackViewSetting` (`SonataDocument.SongSetting`, mounted
 * afresh for each loaded song, so a song switch starts from that song's own
 * read): syncs the song's persisted track-view overrides into the loaded song,
 * where every track-mixer hook reads them and the shell's score gate waits for
 * them.
 *
 * It writes only a settled answer: a newly loaded song's settings start
 * pending, so until this song's rows arrive no track sounds or draws with a
 * default view (a muted track audible) or with the previous song's — and a
 * write for a song no longer loaded is dropped.
 */
export function TrackViewObserver() {
  const songId = useMountedSongId();
  const setTrackViews = useWriteSongSetting(trackViewSetting);
  const failSetting = useFailSongSetting(trackViewSetting);
  const views = useLive(trackViews, trackViewScope(songId));
  // A failed read settles only from its last-seen rows (`stale`); with none the
  // setting is reported FAILED (below) — never a stand-in value — so the
  // player shows the failure with Retry instead of waiting forever.
  const settled = foldResource(views, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (rows) => rows,
  });

  useEffect(() => {
    if (settled === undefined) return;
    setTrackViews(songId, settled);
  }, [songId, settled, setTrackViews]);

  // The read failed with nothing to settle from: the setting is FAILED.
  const failedError =
    views.status === "error" && views.stale === undefined
      ? views.error
      : undefined;
  const refetch = views.refetch;
  useEffect(() => {
    if (failedError === undefined) return;
    failSetting(songId, { error: failedError, refetch });
  }, [songId, failedError, refetch, failSetting]);

  return null;
}
