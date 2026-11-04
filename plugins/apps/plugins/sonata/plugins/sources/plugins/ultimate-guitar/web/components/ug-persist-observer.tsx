import { useRef } from "react";
import { usePersistSourceEdit } from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { UgSourceRawSchema } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core";
import { compile } from "../compile";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { useSaveUltimateGuitar } from "../actions";

/**
 * Headless, always-mounted persistence observer for the Ultimate Guitar source,
 * contributed to `Sonata.Effect`. Treats the loaded document as the source of
 * truth and persists a full `UgTab` snapshot (plus derived duration / end beat)
 * to the server whenever an edit changes the raw's `tab` — never the raw a load
 * handed it, and never when only `raw.alignment` changes (an alignment landing
 * is not an edit). `usePersistSourceEdit` hands each edit WITH the song it
 * belongs to, debounced, and saves a pending edit at once when another song
 * loads or the app unmounts — so one song's tab cannot be saved under another's
 * id, and the last edit before a switch is never dropped.
 *
 * This lives OUTSIDE the editor section deliberately: a section body is unmounted
 * while its card is collapsed, so an in-body save would stop observing the moment
 * the card is collapsed. A `Sonata.Effect` is mounted for the whole open song
 * regardless of card state. A song of any other source never edits the
 * `UG_SOURCE_ID` raw, so it stays `unedited` and nothing is saved.
 *
 * The `PUT` persists `title: songName` (the one place a UG song's title is
 * written); the toolbar title re-renders off the library's live `songs` value,
 * not an in-memory mirror.
 */
export function UltimateGuitarPersistObserver() {
  const saveTab = useSaveUltimateGuitar();
  // The tab as last persisted in each load, serialized. Only a change of the
  // TAB is an edit: the alignment child rewrites `raw.alignment` when a job
  // lands, and that must never read as a sheet edit (nor re-save it). Keyed on
  // the song and load, so a new load's baseline is its own tab as loaded.
  const saved = useRef<{ songId: string; load: number; tab: string } | null>(
    null,
  );
  usePersistSourceEdit(UG_SOURCE_ID, (edit) => {
    const { songId, load } = edit;
    const parsed = UgSourceRawSchema.safeParse(edit.raw);
    if (!parsed.success) return;
    const raw = parsed.data;
    const tabJson = JSON.stringify(raw.tab);
    const baseline =
      saved.current?.songId === songId && saved.current.load === load
        ? saved.current.tab
        : edit.asLoaded === undefined
          ? null
          : JSON.stringify(UgSourceRawSchema.parse(edit.asLoaded).tab);
    if (tabJson === baseline) return;
    saved.current = { songId, load, tab: tabJson };
    const score = compile(raw);
    const endBeat = scoreEndBeat(score);
    saveTab(songId, {
      ...raw.tab,
      durationSec: beatToSeconds(score, endBeat),
      endBeat,
    });
  });
  return null;
}
