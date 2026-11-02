import { useEffect } from "react";
import {
  transposeSetting,
  useFailSongSetting,
  useMountedSongId,
  useWriteSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { transposes } from "../../shared/resources";

/**
 * Headless observer of the `transposeSetting` (`SonataDocument.SongSetting`, mounted
 * afresh for each loaded song): syncs that song's persisted transpose offset
 * into the loaded song, whose score pipeline reads it to shift the whole song.
 *
 * It writes only a settled answer: a newly loaded song's settings start
 * pending, so until this song's row arrives nothing renders under the previous
 * song's offset or a stand-in `0` — and a write for a song no longer loaded is
 * dropped. An absent row (`found: false`) IS the song's offset: `0`.
 */
export function TransposeObserver() {
  const songId = useMountedSongId();
  const setTranspose = useWriteSongSetting(transposeSetting);
  const failSetting = useFailSongSetting(transposeSetting);
  const row = useLive(transposes, { id: songId });
  // The row read reduced to the value it settles to — `undefined` while it is
  // loading — so the effect below runs on a real change only.
  // A failed read settles only from its last-seen row (`stale`); with none the
  // setting is reported FAILED (below) — never a stand-in value — so the
  // player shows the failure with Retry instead of waiting forever.
  let semitones: number | undefined;
  switch (row.status) {
    case "loading":
      semitones = undefined;
      break;
    case "error":
      semitones = row.stale?.semitones;
      break;
    case "ready":
      semitones = row.found ? row.row.semitones : 0;
      break;
  }

  useEffect(() => {
    if (semitones === undefined) return;
    setTranspose(songId, semitones);
  }, [songId, semitones, setTranspose]);

  // The read failed with nothing to settle from: the setting is FAILED.
  const failedError =
    row.status === "error" && row.stale === undefined ? row.error : undefined;
  const refetch = row.refetch;
  useEffect(() => {
    if (failedError === undefined) return;
    failSetting(songId, { error: failedError, refetch });
  }, [songId, failedError, refetch, failSetting]);

  return null;
}
