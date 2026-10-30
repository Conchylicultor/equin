// 43.29–47.54 s · Desktop: Circle fills the frame, held through one beat of
// silence; on the music's lift the camera pulls back and Circle turns out to
// be a window in equin's desktop mode, among other windows, over the shelf.

import { image, rectOf, type Vec2 } from "@plugins/media/plugins/film/e2e";
import { CENTER, type Ctx, type Scene } from "./kit";
import { beat, SECTIONS } from "./timeline";

/** The beat of silence before the reveal, and the reveal (the track's lift). */
export const SILENCE_AT = beat(51);
export const REVEAL_AT = beat(52);

export function desktop({ m }: Ctx): Scene {
  const t0 = SECTIONS.desktop.from; // 43.29
  const win = rectOf(m, "desktop-window-circle"); // the window's content
  const scale = win.width / 1280;
  // The camera that makes the scaled Circle screen fill the frame exactly.
  const inZoom = 1 / scale;
  const inFocus: Vec2 = [win.x + win.width / 2, win.y + (720 * scale) / 2];
  const settled = REVEAL_AT + 1.5;

  return {
    layers: [
      image("desktop", { start: t0, end: SECTIONS.mac.from + 1.0 }),
      image("circle-single", {
        start: t0,
        end: REVEAL_AT + 0.4,
        origin: [0, 0],
        x: win.x,
        y: win.y,
        scale,
        opacity: [
          [REVEAL_AT + 0.04, 1],
          [REVEAL_AT + 0.36, 0, "inOutSine"],
        ],
      }),
    ],
    cam: {
      focus: [
        [t0, CENTER],
        [t0, inFocus, "step"],
        [REVEAL_AT, inFocus],
        [settled, CENTER, { bezier: [0.16, 1, 0.3, 1] }],
      ],
      zoom: [
        [t0, 1],
        [t0, inZoom, "step"],
        [SILENCE_AT, inZoom * 1.025, "inOutSine"],
        [REVEAL_AT, inZoom * 1.03],
        [settled, 1, { bezier: [0.16, 1, 0.3, 1] }],
      ],
      tiltX: [
        [REVEAL_AT, 0],
        [REVEAL_AT + 0.6, 4, "outSine"],
        [settled + 0.4, 0, "inOutSine"],
      ],
    },
    sfx: [
      {
        kind: "whoosh",
        at: REVEAL_AT - 0.05,
        dur: 1.1,
        gain: 0.45,
        dir: "down",
      },
    ],
  };
}
