// The equin showcase film (the Video page's Script v2 and its Preferences):
// one continuous recorded session of the real app on the seeded promo-film
// composition, ending on equin's desktop mode. Renders from what
// e2e/record.ts recorded (never records itself); the music is
// internal/music.ts's FILM_MUSIC (or, to audition, --music <slug>).
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts --preview
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts --stills 5,12,30 [--captions]
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts            # new version
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts --captions # its captions
//
// The render runs on parallel pages (film's --workers, default from the host's
// cores; --workers 1 renders serially) — the same film either way.
//
// Every render is a new version, never an overwrite (runFilm refuses one):
// the plain render writes ~/Downloads/showcase/equin-v<N>.mp4 with N one past
// the newest there; --captions writes equin-v<N>-captions.mp4 for the newest
// version that has none yet (render the plain variant first); each full
// render also writes its light web version beside it (`<name>-web.mp4`,
// media/film's webEncodeArgs); a preview
// writes equin-v<N>-preview[-k].mp4 for the version about to be rendered.
//
// --music <slug> renders the newest version's recordings with another track
// (internal/music.ts's FILM_MUSIC_TRACKS: its file, beat grid and section) to
// equin-v<N>-music-<slug>.mp4 — FILM_MUSIC stays as it is. One render per
// track; a second one with the same slug is refused (never an overwrite).
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts --music hug-convoy

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import { usage } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { runFilm, type FilmContext } from "@plugins/media/plugins/film/e2e";
import { buildFilm } from "./internal/film";
import {
  FILM_MUSIC,
  FILM_MUSIC_TRACKS,
  filmMusicBySlug,
} from "./internal/music";

/** Where the film's versions live. */
const SHOWCASE = join(HOME_DIR, "Downloads/showcase");

/** The output for this render: the next free version name (see above). */
function versionedOut(ctx: FilmContext): string {
  const files = readdirSync(SHOWCASE);
  const has = (f: string) => files.includes(f);
  const versions = files
    .map((f) => /^equin-v(\d+)\.mp4$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const newest = versions.length ? Math.max(...versions) : -1;
  const music = ctx.option("music");
  if (music !== undefined) {
    if (newest < 0 || ctx.preview || ctx.flag("captions"))
      usage(
        "promo-film: --music renders the newest version's recordings with another track — a plain render (no --preview / --captions) of an existing version",
      );
    return join(SHOWCASE, `equin-v${newest}-music-${music}.mp4`);
  }
  if (ctx.preview) {
    const n = newest + 1;
    for (let k = 1; ; k++) {
      const f = `equin-v${n}-preview${k === 1 ? "" : `-${k}`}.mp4`;
      if (!has(f)) return join(SHOWCASE, f);
    }
  }
  if (ctx.flag("captions")) {
    if (newest < 0 || has(`equin-v${newest}-captions.mp4`))
      usage(
        `promo-film: equin-v${newest}.mp4 already has its captions (or there is no version yet) — render the plain variant of the new version first`,
      );
    return join(SHOWCASE, `equin-v${newest}-captions.mp4`);
  }
  return join(SHOWCASE, `equin-v${newest + 1}.mp4`);
}

await runFilm({
  name: "equin",
  out: versionedOut,
  // Beside every full render, its light web version (equin-v<N>-web.mp4,
  // equin-v<N>-music-<slug>-web.mp4): what the website streams.
  web: true,
  flags: { captions: "adds the section captions (bottom-left)" },
  options: {
    music: `renders the newest version with another track: ${Object.keys(FILM_MUSIC_TRACKS).join(" | ")}`,
  },
  async build(ctx) {
    const slug = ctx.option("music");
    const film = await buildFilm({
      captions: ctx.flag("captions"),
      music: slug === undefined ? FILM_MUSIC : filmMusicBySlug(slug),
    });
    for (const s of film.timeline.sections)
      console.log(
        `  ${s.id.padEnd(12)} ${s.from.toFixed(2).padStart(6)} → ${s.to.toFixed(2).padStart(6)} s`,
      );
    return film;
  },
});
