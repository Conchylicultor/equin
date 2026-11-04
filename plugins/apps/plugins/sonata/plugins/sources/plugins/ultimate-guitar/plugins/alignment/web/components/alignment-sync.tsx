import { useEffect } from "react";
import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import {
  appliedAlignment,
  UgSourceRawSchema,
  type UgSourceRaw,
} from "../../core";
import { useUgAlignment } from "../internal/use-ug-raw";

/**
 * Headless, always-mounted bridge from the alignment's live row to the UG raw
 * (`Sonata.Effect`): when a job lands, the applied record is written into
 * `raw.alignment`, so the Score recompiles onto the recording's beats.
 *
 * What is written is `appliedAlignment` — the rule `hydrate` applies too: the
 * row's record when it was made for the row's video (or is the resolver's best
 * try, with none chosen) and the open sheet, whatever its score — else `null`
 * (another video's or sheet's record, no record, no row).
 * A re-align queued or running keeps the current alignment playing until its
 * result lands. The comparison is by value, so the raw changes (and playback
 * resets) at most once per finished job — not on every status write, and not
 * after `hydrate` already opened the song aligned. A row still loading or unreadable leaves the raw as
 * hydrated; the Recording section shows why.
 *
 * The write is derived from the raw held when it lands, not the one this
 * render read: the record is applied to the current tab (a sheet edit since
 * the render is kept), and the write is bound to the document the row was read
 * for — a row of an earlier song never lands on the next one.
 *
 * Lives outside the Recording section because a section body unmounts while
 * collapsed. The UG persist observer ignores a change of `raw.alignment`, so
 * this write is never saved as a sheet edit.
 */
export function UgAlignmentSync() {
  const { editSourceRaw } = useSongDocument();
  const { raw, row } = useUgAlignment();

  useEffect(() => {
    if (raw === undefined || row.status !== "ready") return;
    const record = row.found ? row.row : null;
    editSourceRaw(UG_SOURCE_ID, (current) => {
      const held = UgSourceRawSchema.parse(current);
      const applied = appliedAlignment(record, held.tab.content);
      if (JSON.stringify(applied) === JSON.stringify(held.alignment)) {
        return current;
      }
      return { tab: held.tab, alignment: applied } satisfies UgSourceRaw;
    });
  }, [raw, row, editSourceRaw]);

  return null;
}
