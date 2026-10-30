// 21.2–24.6 s · More apps: Sonata → Deploy (one quick cut on the beat, held
// one beat, zoomed and softened so its form is not read) → Places, where the
// camera settles and stays (the evolving scene draws Places itself).

import { image } from "@plugins/media/plugins/film/e2e";
import { CENTER, type Ctx, type Scene } from "./kit";
import { beat, SECTIONS } from "./timeline";

/** The cut to Places (one beat after Deploy). */
export const PLACES_CUT = beat(25);

export function moreApps(_ctx: Ctx): Scene {
  const t0 = SECTIONS.moreApps.from; // 21.20
  return {
    layers: [
      image("deploy", {
        start: t0,
        end: PLACES_CUT,
        blur: [
          [t0, 2.2],
          [PLACES_CUT, 1.2],
        ],
      }),
    ],
    cam: {
      focus: [
        [t0, CENTER],
        [t0, [760, 330], "step"],
        [PLACES_CUT, [800, 345], "linear"],
        [PLACES_CUT, CENTER, "step"],
      ],
      zoom: [
        [t0, 1.06],
        [t0, 1.34, "step"],
        [PLACES_CUT, 1.4, "linear"],
        [PLACES_CUT, 1.1, "step"],
        [PLACES_CUT + 1.3, 1, "outCubic"],
      ],
    },
    sfx: [
      { kind: "tick", at: t0, gain: 0.9 },
      { kind: "whoosh", at: t0 - 0.12, dur: 0.3, gain: 0.25 },
      { kind: "tick", at: PLACES_CUT, gain: 0.8 },
      { kind: "whoosh", at: PLACES_CUT - 0.12, dur: 0.3, gain: 0.22 },
    ],
  };
}
