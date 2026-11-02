import { useEffect } from "react";
import {
  chordModeSetting,
  useFailSongSetting,
  useMountedSongId,
  useWriteSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { chordModes } from "../../shared/resources";

/**
 * Headless observer of the `chordModeSetting` (`SonataDocument.SongSetting`, mounted
 * afresh for each loaded song): syncs that song's persisted chord mode into the
 * loaded song, whose score pipeline reads it to decide whether to run the
 * second, all-chords voicing pass.
 *
 * It writes only a settled answer: a newly loaded song's settings start
 * pending, so until this song's row arrives nothing renders under the previous
 * song's mode or a stand-in "off" — and a write for a song no longer loaded is
 * dropped. An absent row (`found: false`) IS the song's mode: off.
 */
export function ChordModeObserver() {
  const songId = useMountedSongId();
  const setChordMode = useWriteSongSetting(chordModeSetting);
  const failSetting = useFailSongSetting(chordModeSetting);
  const row = useLive(chordModes, { id: songId });
  // The row read reduced to the value it settles to — `undefined` while it is
  // loading — so the effect below runs on a real change only.
  // A failed read settles only from its last-seen row (`stale`); with none the
  // setting is reported FAILED (below) — never a stand-in value — so the
  // player shows the failure with Retry instead of waiting forever.
  let enabled: boolean | undefined;
  switch (row.status) {
    case "loading":
      enabled = undefined;
      break;
    case "error":
      enabled = row.stale?.enabled;
      break;
    case "ready":
      enabled = row.found && row.row.enabled;
      break;
  }

  useEffect(() => {
    if (enabled === undefined) return;
    setChordMode(songId, enabled);
  }, [songId, enabled, setChordMode]);

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
