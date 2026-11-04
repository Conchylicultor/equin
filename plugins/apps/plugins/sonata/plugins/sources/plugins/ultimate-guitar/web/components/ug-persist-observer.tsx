import { useEffect, useRef } from "react";
import { useSourceEdit } from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { UgSourceRawSchema } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core";
import { compile } from "../compile";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { useSaveUltimateGuitar } from "../actions";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Headless, always-mounted persistence observer for the Ultimate Guitar source,
 * contributed to `Sonata.Effect`. Treats the loaded document as the source of
 * truth and debounce-persists a full `UgTab` snapshot (plus derived duration / end
 * beat) to the server whenever an edit changes the raw's `tab` — never the raw a
 * load handed it, and never when only `raw.alignment` changes (an alignment
 * landing is not an edit). It reads the edit WITH the song it belongs to
 * (`useSourceEdit`), so one song's tab cannot be saved under another's id.
 *
 * This lives OUTSIDE the editor section deliberately: a section body is unmounted
 * while its card is collapsed, so an in-body debounced save would silently drop a
 * pending edit (the effect cleanup clears the timer) and stop observing the moment
 * the card is collapsed mid-debounce — data loss. A `Sonata.Effect` is mounted for
 * the whole open song regardless of card state, so no edit is ever lost. A song
 * of any other source never edits the `UG_SOURCE_ID` raw, so it stays `unedited`
 * and nothing is saved.
 *
 * The `PUT` persists `title: songName` (the one place a UG song's title is
 * written); the toolbar title re-renders off the library's live `songs` value,
 * not an in-memory mirror.
 */
export function UltimateGuitarPersistObserver() {
  const edit = useSourceEdit(UG_SOURCE_ID);
  const saveTab = useSaveUltimateGuitar();

  // The tab as last persisted in this load, serialized. Only a change of the
  // TAB is an edit: the alignment child rewrites `raw.alignment` when a job
  // lands, and that must never read as a sheet edit (nor re-save it). Keyed on
  // the load, so a new load's baseline is its own tab as loaded.
  const saved = useRef<{ load: number; tab: string } | null>(null);
  useEffect(() => {
    if (edit.kind !== "edited") return;
    // The song and its tab come as one value: the save can only ever pair this
    // song's tab with this song's id.
    const { songId, load } = edit;
    const parsed = UgSourceRawSchema.safeParse(edit.raw);
    if (!parsed.success) return;
    const raw = parsed.data;
    const tabJson = JSON.stringify(raw.tab);
    const baseline =
      saved.current?.load === load
        ? saved.current.tab
        : edit.asLoaded === undefined
          ? null
          : JSON.stringify(UgSourceRawSchema.parse(edit.asLoaded).tab);
    if (tabJson === baseline) return;
    const timer = setTimeout(() => {
      saved.current = { load, tab: tabJson };
      const score = compile(raw);
      const endBeat = scoreEndBeat(score);
      saveTab(songId, {
        ...raw.tab,
        durationSec: beatToSeconds(score, endBeat),
        endBeat,
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [edit, saveTab]);

  return null;
}
