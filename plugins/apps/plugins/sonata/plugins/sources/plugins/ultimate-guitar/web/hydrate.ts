import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { SourceHydration } from "@plugins/apps/plugins/sonata/plugins/library/web";
import {
  appliedAlignment,
  ugAlignmentRows,
  type UgSourceRaw,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core";
import { songUgRows } from "../shared/resources";

/**
 * Hydrate a song's UG source, live: its persisted `UgTab` and its alignment
 * row together, as the raw for `useLoadDocument` (keyed under
 * `"ultimate-guitar"`), so an already-aligned song opens aligned — no
 * recompile-and-reset when the alignment's sync effect runs a moment later.
 * The record goes in by the same rule that sync effect applies
 * (`appliedAlignment`: made for the row's video — or its best try when none
 * was chosen — and this sheet, whatever its score).
 *
 * `absent` for a song that carries no UG tab, so it's skipped in the library's
 * generic collection — and the UG editor section stays hidden for it.
 */
export function useHydration(songId: string): ResourceResult<SourceHydration> {
  const tab = mapRow(useLiveRow(songUgRows, songId), (r) => r);
  const alignment = mapRow(useLiveRow(ugAlignmentRows, songId), (r) => r);
  return mapResource(
    combineResources({ tab, alignment }),
    ({ tab: row, alignment: aligned }): SourceHydration => {
      if (row === null) return { kind: "absent" };
      const raw: UgSourceRaw = {
        tab: {
          tabId: row.tabId,
          songName: row.songName,
          artistName: row.artistName,
          type: row.type,
          key: row.key,
          capo: row.capo,
          tuning: row.tuning,
          content: row.content,
          urlWeb: row.urlWeb,
        },
        alignment: appliedAlignment(aligned, row.content),
      };
      return { kind: "raw", raw };
    },
  );
}
