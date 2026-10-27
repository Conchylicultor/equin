import { useMemo } from "react";
import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import {
  UgSourceRawSchema,
  type UgAlignmentRow,
  type UgSourceRaw,
} from "../../core";
import { ugAlignmentRows } from "../../core";

/**
 * The open song's UG raw, parsed (`undefined` for a song with no UG source),
 * and its alignment's live row. A raw under the UG key that does not parse is a
 * broken invariant (the UG source wrote it) and throws.
 */
/**
 * The open document's UG song: its library id and parsed raw, or `null` when
 * the document has no UG source or is not a library song (a file document has
 * no alignment row). The Recording section's gate and its body both read this,
 * so the two can never disagree.
 */
export function useUgLibrarySong(): {
  songId: string;
  raw: UgSourceRaw;
} | null {
  // The document's own identity, loaded WITH the raw, so a raw is never paired
  // with another song's id.
  const { sourceRaw, identity } = useSongDocument();
  const rawValue = sourceRaw(UG_SOURCE_ID);
  const raw = useMemo(
    () =>
      rawValue === undefined ? undefined : UgSourceRawSchema.parse(rawValue),
    [rawValue],
  );
  if (raw === undefined || identity?.kind !== "library") return null;
  return { songId: identity.songId, raw };
}

export function useUgAlignment(): {
  songId: string | null;
  raw: UgSourceRaw | undefined;
  row: LiveRowResult<UgAlignmentRow>;
} {
  const song = useUgLibrarySong();
  const row = useLiveRow(ugAlignmentRows, song?.songId ?? null);
  return { songId: song?.songId ?? null, raw: song?.raw, row };
}
