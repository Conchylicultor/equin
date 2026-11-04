import { usePersistSourceEdit } from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { asChordGridRaw, compile } from "../../core";
import { CHORD_GRID_SOURCE_ID } from "../constants";
import { useSaveChordGrid } from "../actions";

/**
 * Headless, always-mounted persistence observer for the chord-grid source,
 * contributed to `Sonata.Effect`. Treats the loaded document as the source of
 * truth and persists the loaded song's grid text plus its derived metrics
 * (duration / end beat) to the server on every edit — never the raw a load
 * handed it. `usePersistSourceEdit` hands each edit WITH the song it belongs
 * to, debounced, and saves a pending edit at once when another song loads or
 * the app unmounts — so one song's grid cannot be saved under another's id,
 * and the last edit before a switch is never dropped.
 *
 * This lives OUTSIDE the editor section deliberately: a section body is unmounted
 * while its card is collapsed, so an in-body save would stop observing the moment
 * the card is collapsed. A `Sonata.Effect` is mounted for the whole open song
 * regardless of card state. A song of any other source never edits the
 * `CHORD_GRID_SOURCE_ID` raw, so it stays `unedited` and nothing is saved.
 *
 * The title is NOT persisted here — it is generic, source-agnostic metadata owned
 * by the library and edited from the player toolbar title (patched via
 * `PATCH /api/sonata/songs/:id`); this save carries only the grid.
 */
export function ChordGridPersistObserver() {
  const saveGrid = useSaveChordGrid();
  usePersistSourceEdit(CHORD_GRID_SOURCE_ID, ({ songId, raw: rawValue }) => {
    const raw = asChordGridRaw(rawValue);
    const score = compile(raw);
    const endBeat = scoreEndBeat(score);
    saveGrid(songId, {
      chordText: raw.text,
      durationSec: beatToSeconds(score, endBeat),
      endBeat,
    });
  });
  return null;
}
