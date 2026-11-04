import { useEffect, useRef } from "react";
import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { asChordGridRaw, compile } from "../../core";
import { CHORD_GRID_SOURCE_ID } from "../constants";
import { useSaveChordGrid } from "../actions";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Headless, always-mounted persistence observer for the chord-grid source,
 * contributed to `Sonata.Effect`. Treats the context (`rawById`) as the source of
 * truth and debounce-persists the open song's grid text plus its derived metrics
 * (duration / end beat) to the server whenever the raw changes — never on the
 * fresh load of a song (which bumps `songLoadEpoch`), only on
 * edits.
 *
 * This lives OUTSIDE the editor section deliberately: a section body is unmounted
 * while its card is collapsed, so an in-body debounced save would silently drop a
 * pending edit (the effect cleanup clears the timer) and stop observing the moment
 * the card is collapsed mid-debounce — data loss. A `Sonata.Effect` is mounted for
 * the whole open song regardless of card state, so no edit is ever lost. Its
 * internal `rawValue === undefined` guard makes it a no-op for songs of any other
 * source (only the chord-grid song carries a defined `CHORD_GRID_SOURCE_ID` raw).
 *
 * The title is NOT persisted here — it is generic, source-agnostic metadata owned
 * by the library and edited from the player toolbar title (patched via
 * `PATCH /api/sonata/songs/:id`); this save carries only the grid.
 */
export function ChordGridPersistObserver() {
  const { sourceRaw } = useSongDocument();
  const { currentSongId, songLoadEpoch } = useSonataApp();
  const saveGrid = useSaveChordGrid();

  const rawValue = sourceRaw(CHORD_GRID_SOURCE_ID);

  const seededEpoch = useRef(songLoadEpoch);
  useEffect(() => {
    if (!currentSongId || rawValue === undefined) return;
    // Skip the echo right after a song loads (hydrate set raw and bumped the epoch in one write).
    if (seededEpoch.current !== songLoadEpoch) {
      seededEpoch.current = songLoadEpoch;
      return;
    }
    const id = currentSongId;
    const raw = asChordGridRaw(rawValue);
    const timer = setTimeout(() => {
      const score = compile(raw);
      const endBeat = scoreEndBeat(score);
      saveGrid(id, {
        chordText: raw.text,
        durationSec: beatToSeconds(score, endBeat),
        endBeat,
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rawValue, currentSongId, songLoadEpoch, saveGrid]);

  return null;
}
