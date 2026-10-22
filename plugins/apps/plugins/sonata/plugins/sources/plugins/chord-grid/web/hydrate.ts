import type {
  SourceContext,
  SourceHydration,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { getSongChordGrid } from "../shared/endpoints";
import type { ChordGridRaw } from "./compile";

/**
 * Hydrate a song's chord-grid source: fetch the persisted grid and hand back the
 * `ChordGridRaw` for `useLoadDocument` (keyed under `"chord-grid"`). Returns `undefined`
 * for a song that carries no chord grid, so it's skipped in the library's generic
 * collection — and so the chord-grid editor section stays hidden for such songs.
 */
export async function hydrate(
  songId: string,
  { fetchEndpoint }: SourceContext,
): Promise<SourceHydration> {
  const row = await fetchEndpoint(getSongChordGrid, { id: songId });
  if (!row) return { kind: "absent" };
  return { kind: "raw", raw: { text: row.chordText } satisfies ChordGridRaw };
}
