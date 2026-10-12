import { useEffect } from "react";
import {
  grooveSetting,
  useFailSongSetting,
  useMountedSongId,
  useWriteSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { rhythms, type RhythmRow } from "../../shared/resources";

/**
 * Headless observer of the `grooveSetting` (`SonataDocument.SongSetting`, mounted
 * afresh for each loaded song): syncs that song's persisted rhythm groove into
 * the loaded song, whose score pipeline reads it to re-voice the chords with
 * the groove.
 *
 * It writes only a settled answer: a newly loaded song's settings start
 * pending, so until this song's row arrives nothing renders under the previous
 * song's groove or a stand-in "no groove" — and a write for a song no longer
 * loaded is dropped. A settled `null` — an absent row, or `enabled` off — IS
 * the song's groove: block chords.
 */
export function RhythmObserver() {
  const songId = useMountedSongId();
  const setGroove = useWriteSongSetting(grooveSetting);
  const failSetting = useFailSongSetting(grooveSetting);
  const row = useLiveRow(rhythms, songId);
  // The row read reduced to what the effect needs: whether it has settled, and
  // the row itself (the cache's own object, identity-stable until it changes) —
  // so the effect runs on a real change only.
  // A failed read settles only from its last-seen row (`stale`); with none the
  // setting is reported FAILED (below) — never a stand-in value — so the
  // player shows the failure with Retry instead of waiting forever.
  let settled: boolean;
  let persisted: RhythmRow | null;
  switch (row.status) {
    case "loading":
      settled = false;
      persisted = null;
      break;
    case "error":
      settled = row.stale !== undefined;
      persisted = row.stale ?? null;
      break;
    case "ready":
      settled = true;
      persisted = row.found ? row.row : null;
      break;
  }

  useEffect(() => {
    if (!settled) return;
    setGroove(
      songId,
      persisted && persisted.enabled
        ? {
            hands: { bass: persisted.bass, chord: persisted.chord },
            bassFigurationId: persisted.bassPatternId,
            chordFigurationId: persisted.chordPatternId,
            bassVoicing: persisted.bassVoicing,
            chordVoicing: persisted.chordVoicing,
          }
        : null,
    );
  }, [songId, settled, persisted, setGroove]);

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
