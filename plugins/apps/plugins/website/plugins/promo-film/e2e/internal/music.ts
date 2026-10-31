// The film's music — THE one place to swap it. The cut does not depend on the
// track (sections follow the recordings, not a beat grid), so changing this
// constant and re-running film.ts re-renders with the new track; nothing is
// recorded again.
//
// - `{ kind: "dep" }`: the pinned, license-checked `promo-music` dep
//   (../../deps), installed on demand.
// - `{ kind: "file", path, sectionStart }`: any local file (an audition).
//
// Now: a PLACEHOLDER while the user auditions candidates — #11, "Can't Stop My
// Feet!" by Loyalty Freak Music (album ROLLER DISCO DANCE DANCE, 2018,
// archive.org/details/LoyaltyFreakMusic-ROLLERDISCODANCEDANCE), from its start,
// exactly as the 64 s preview the user heard. Once picked, pin it as the
// `promo-music` dep (sha256, license) and switch this to `{ kind: "dep" }`.

import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { downloadedFile } from "@plugins/infra/plugins/deps/plugins/download/deps";
import { PROMO_MUSIC, promoMusic } from "../../deps";

export type FilmMusic =
  { kind: "dep" } | { kind: "file"; path: string; sectionStart: number };

export const FILM_MUSIC: FilmMusic = {
  kind: "file",
  path: join(
    HOME_DIR,
    "Downloads/showcase/music-candidates/11-cant-stop-my-feet-loyalty-freak-music.mp3",
  ),
  sectionStart: 0,
};

/** The music file and where film t=0 starts in it. */
export async function resolveFilmMusic(): Promise<{
  file: string;
  sectionStart: number;
}> {
  if (FILM_MUSIC.kind === "file")
    return { file: FILM_MUSIC.path, sectionStart: FILM_MUSIC.sectionStart };
  const ready = await ensureDepViaCli(promoMusic, {
    stdio: "inherit",
    grant: null,
  });
  return {
    file: downloadedFile(ready, PROMO_MUSIC.file),
    sectionStart: PROMO_MUSIC.sectionStart,
  };
}
