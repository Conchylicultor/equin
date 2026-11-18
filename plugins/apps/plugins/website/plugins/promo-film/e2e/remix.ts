// The showcase film under another music, without rendering a frame: media/film's
// remixFilm over a finished film's kept sound (`<film>.sound/`), its SFX and
// levels unchanged, the bed swapped for a FILM_MUSIC_TRACKS track — one of
// its bars put where the film's own track had one (the montage's first
// window), its gain automation the film's. The cuts stay timed to the film's
// own track; to cut to the new one, render it (`film.ts --music <slug>`).
//
// Writes `<film>-music-<slug>.mp4` beside the film (and its `-web.mp4` when
// the film has one), never over an existing file.
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/remix.ts \
//     --film ~/Downloads/showcase/equin-v23.mp4 --music go-to-the-picnic

import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import {
  arg,
  usage,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { remixFilm } from "@plugins/media/plugins/film/e2e";
import {
  FILM_MUSIC_TRACKS,
  filmMusicBySlug,
  musicStartFor,
  resolveFilmMusic,
} from "./internal/music";

const film = arg("film")?.replace(/^~(?=\/|$)/, HOME_DIR);
const slug = arg("music");
if (!film || !slug)
  usage(
    `promo-film remix: --film <film.mp4> --music <${Object.keys(FILM_MUSIC_TRACKS).join(" | ")}>`,
  );
const track = filmMusicBySlug(slug);
const resolved = await resolveFilmMusic(track);

await remixFilm({
  film,
  out: film.replace(/\.mp4$/i, `-music-${slug}.mp4`),
  music(prev) {
    if (!prev) throw new Error(`promo-film remix: ${film} has no music bed`);
    return {
      file: resolved.file,
      sectionStart:
        resolved.sectionStart +
        (prev.barAt === undefined ? 0 : musicStartFor(track, prev.barAt)),
      gainDb: prev.gainDb,
      ...(prev.barAt === undefined ? {} : { barAt: prev.barAt }),
    };
  },
});
