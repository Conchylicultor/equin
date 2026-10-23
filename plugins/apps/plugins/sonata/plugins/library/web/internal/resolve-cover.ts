import type { Song } from "../../core";
import type { SongCoverAnswer } from "../slots";

/** One `Library.Cover` contribution, as the resolver reads it. */
export interface SongCoverSource {
  id: string;
  cover: (song: Song) => SongCoverAnswer | undefined;
}

/**
 * Fold every `Library.Cover` contribution's answer for one song into the one
 * the cover draws, whatever order the contributions come in:
 *
 * - a `failed` answer wins — a cover that could not be made is said, never
 *   hidden behind another source's art;
 * - else a `pending` one — the cover is still being made;
 * - else the one `art` answer.
 *
 * Two `art` answers for one song throw: two sources both claiming to be the
 * song's picture is a composition bug, and picking one would hide it. No
 * answer at all is `undefined` — the quiet cover alone.
 */
export function resolveSongCover(
  sources: readonly SongCoverSource[],
  song: Song,
): SongCoverAnswer | undefined {
  let failed: SongCoverAnswer | undefined;
  let pending: SongCoverAnswer | undefined;
  let art: { id: string; answer: SongCoverAnswer } | undefined;
  for (const source of sources) {
    const answer = source.cover(song);
    if (answer === undefined) continue;
    switch (answer.kind) {
      case "failed":
        failed ??= answer;
        break;
      case "pending":
        pending ??= answer;
        break;
      case "art":
        if (art !== undefined) {
          throw new Error(
            `Library.Cover: "${art.id}" and "${source.id}" both answer art for song "${song.id}" — one song, one picture.`,
          );
        }
        art = { id: source.id, answer };
        break;
    }
  }
  return failed ?? pending ?? art?.answer;
}
