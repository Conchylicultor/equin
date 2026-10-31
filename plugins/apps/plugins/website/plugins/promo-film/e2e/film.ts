// The equin showcase film (the Video page's Script v2 and its Preferences):
// one continuous recorded session of the real app on the seeded promo-film
// composition, ending on equin's desktop mode. Renders from what
// e2e/record.ts recorded (never records itself); the music is
// internal/music.ts's FILM_MUSIC.
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts --preview
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts --stills 5,12,30 [--captions]
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts            # new version
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts --captions # its captions
//
// Every render is a new version, never an overwrite (runFilm refuses one):
// the plain render writes ~/Downloads/showcase/equin-v<N>.mp4 with N one past
// the newest there; --captions writes equin-v<N>-captions.mp4 for the newest
// version that has none yet (render the plain variant first); a preview
// writes equin-v<N>-preview[-k].mp4 for the version about to be rendered.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { usage } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { runFilm, type FilmContext } from "@plugins/media/plugins/film/e2e";
import { buildFilm } from "./internal/film";

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
  flags: { captions: "adds the section captions (bottom-left)" },
  async build(ctx) {
    const film = await buildFilm({ captions: ctx.flag("captions") });
    for (const s of film.timeline.sections)
      console.log(
        `  ${s.id.padEnd(12)} ${s.from.toFixed(2).padStart(6)} → ${s.to.toFixed(2).padStart(6)} s`,
      );
    return film;
  },
});
