import type {
  SourceContext,
  SourceHydration,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import {
  appliedAlignment,
  getUgAlignment,
  type UgSourceRaw,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core";
import { getSongUltimateGuitar } from "../shared/endpoints";

/**
 * Hydrate a song's UG source: fetch the persisted `UgTab` and its alignment
 * together and hand them back for `useLoadDocument` (keyed under `"ultimate-guitar"`),
 * so an already-aligned song opens aligned — no recompile-and-reset when the
 * alignment's live row arrives a moment later. The record goes in by the same
 * rule the alignment child's sync effect applies (`appliedAlignment`: made for
 * the row's video — or its best try when none was chosen — and this sheet,
 * whatever its score).
 *
 * Returns `absent` for a song that carries no UG tab, so it's skipped in the
 * library's generic collection — and the UG editor section stays hidden for it.
 */
export async function hydrate(
  songId: string,
  { fetchEndpoint }: SourceContext,
): Promise<SourceHydration> {
  const [tab, alignment] = await Promise.all([
    fetchEndpoint(getSongUltimateGuitar, { id: songId }),
    fetchEndpoint(getUgAlignment, { id: songId }),
  ]);
  if (tab === null) return { kind: "absent" };
  const raw: UgSourceRaw = {
    tab,
    alignment: appliedAlignment(alignment, tab.content),
  };
  return { kind: "raw", raw };
}
