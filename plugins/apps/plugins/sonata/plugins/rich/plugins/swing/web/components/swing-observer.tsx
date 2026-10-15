import { useEffect } from "react";
import {
  swingSetting,
  useFailSongSetting,
  useMountedSongId,
  useWriteSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import type { SwingOverride } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { swings, type SwingRow } from "../../shared/resources";

/**
 * A song's read as the override it means: no row is the song's own feel. A
 * unit other than 8 / 16 is a corrupt row.
 */
function overrideOf(
  mode: "score" | "straight" | "swing",
  unit: number,
  ratio: number,
): SwingOverride {
  if (mode === "score") return { kind: "score" };
  if (unit !== 8 && unit !== 16) {
    throw new Error(`[swing] stored swing unit must be 8 or 16, got ${unit}`);
  }
  return mode === "straight"
    ? { kind: "straight", feel: { unit, ratio } }
    : { kind: "swing", swing: { unit, ratio } };
}

/**
 * Headless observer of the `swingSetting` (`SonataDocument.SongSetting`,
 * mounted afresh for each loaded song): syncs that song's persisted swing
 * override into the loaded song, whose score pipeline applies it to
 * `meta.swing`. Same contract as `key-mode`'s observer: only a settled answer
 * is written; an absent row IS the setting (the song's own feel); a failed
 * read with nothing to settle from fails the setting.
 */
export function SwingObserver() {
  const songId = useMountedSongId();
  const write = useWriteSongSetting(swingSetting);
  const failSetting = useFailSongSetting(swingSetting);
  const row = useLiveRow(swings, songId);

  // The read reduced to primitives — `undefined` while loading — so the effect
  // below runs on a real change only (a row object is new on every push).
  let found: SwingRow | null | undefined;
  switch (row.status) {
    case "loading":
      found = undefined;
      break;
    case "error":
      found = row.stale;
      break;
    case "ready":
      found = row.found ? row.row : null;
      break;
  }
  // A row-less song has no unit / ratio to read; `overrideOf` ignores them then.
  const mode =
    found === undefined
      ? undefined
      : found === null
        ? "score"
        : found.swung
          ? "swing"
          : "straight";
  const unit = found?.unit ?? 0;
  const ratio = found?.ratio ?? 0;

  useEffect(() => {
    if (mode === undefined) return;
    write(songId, overrideOf(mode, unit, ratio));
  }, [songId, mode, unit, ratio, write]);

  const failedError =
    row.status === "error" && row.stale === undefined ? row.error : undefined;
  const refetch = row.refetch;
  useEffect(() => {
    if (failedError === undefined) return;
    failSetting(songId, { error: failedError, refetch });
  }, [songId, failedError, refetch, failSetting]);

  return null;
}
