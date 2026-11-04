import { useEffect } from "react";
import { useSourceEdit } from "@plugins/apps/plugins/sonata/plugins/document/web";
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
 * contributed to `Sonata.Effect`. Treats the loaded document as the source of
 * truth and debounce-persists the loaded song's grid text plus its derived
 * metrics (duration / end beat) to the server on every edit — never the raw a
 * load handed it. It reads the edit WITH the song it belongs to
 * (`useSourceEdit`), so one song's grid cannot be saved under another's id.
 *
 * This lives OUTSIDE the editor section deliberately: a section body is unmounted
 * while its card is collapsed, so an in-body debounced save would silently drop a
 * pending edit (the effect cleanup clears the timer) and stop observing the moment
 * the card is collapsed mid-debounce — data loss. A `Sonata.Effect` is mounted for
 * the whole open song regardless of card state, so no edit is ever lost. A song
 * of any other source never edits the `CHORD_GRID_SOURCE_ID` raw, so it stays
 * `unedited` and nothing is saved.
 *
 * The title is NOT persisted here — it is generic, source-agnostic metadata owned
 * by the library and edited from the player toolbar title (patched via
 * `PATCH /api/sonata/songs/:id`); this save carries only the grid.
 */
export function ChordGridPersistObserver() {
  const edit = useSourceEdit(CHORD_GRID_SOURCE_ID);
  const saveGrid = useSaveChordGrid();

  useEffect(() => {
    if (edit.kind !== "edited") return;
    // The song and its grid come as one value: the save can only ever pair
    // this song's grid with this song's id.
    const { songId, raw: rawValue } = edit;
    const raw = asChordGridRaw(rawValue);
    const timer = setTimeout(() => {
      const score = compile(raw);
      const endBeat = scoreEndBeat(score);
      saveGrid(songId, {
        chordText: raw.text,
        durationSec: beatToSeconds(score, endBeat),
        endBeat,
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [edit, saveGrid]);

  return null;
}
