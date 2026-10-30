// The equin showcase film (the Video page's Script v2): ~64 s, 1080p60, one
// continuous session over the real app's captures, cut to "The Budding of
// Consciousness". Timeline and scenes: ./internal (timeline.ts is the section
// grid, one module per section). Assets: capture.ts's output.
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/render.ts --preview
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/render.ts --stills 5,12,30 [--captions]
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/render.ts [--captions]
//
// Writes ~/Downloads/showcase/equin-v0.mp4 (or equin-v0-captions.mp4).

import { runFilm } from "@plugins/media/plugins/film/e2e";
import { buildFilm } from "./internal/film";

// The output name follows the variant; runFilm parses (and validates) the flag itself.
const captions = process.argv.includes("--captions");

await runFilm({
  name: "equin-v0",
  out: `~/Downloads/showcase/equin-v0${captions ? "-captions" : ""}.mp4`,
  flags: { captions: "adds the section captions (bottom-left)" },
  build: (ctx) => buildFilm({ captions: ctx.flag("captions") }),
});
