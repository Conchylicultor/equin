// 52.64–58.59 s · Hundreds more features: the Mac shot shrinks into the
// iceberg's "Mac & Linux integration" card sketch, the camera pulls back and
// the other iceberg cards drift in from below a few at a time, settling into
// the iceberg page, which fades in under them. Then (58.6) they fall away.

import {
  html,
  strip,
  type GroupLayer,
  type Key,
  type Layer,
  type Rect,
  type SfxCue,
  type Vec2,
} from "@plugins/media/plugins/film/e2e";
import { CENTER, fadeIn, rand, stripCrop, type Ctx, type Scene } from "./kit";
import { SECTIONS } from "./timeline";

const STRIP = "iceberg";
const MAC_CARD = 12;
/** The drawn Mac inside the Mac & Linux card, in strip page coordinates. */
const SKETCH: Rect = { x: 584, y: 1876, width: 326, height: 214 };
/** Strip → world offset: the sketch's centre lands on the frame's centre. */
const O: Vec2 = [
  CENTER[0] - (SKETCH.x + SKETCH.width / 2),
  CENTER[1] - (SKETCH.y + SKETCH.height / 2),
];

/** The strip's own edge colours by page y (sampled from the capture): sky, the sea level at 935, deepening water. */
const WATER = [
  "#feffff 0px",
  "#edf2f9 710px",
  "#e4ecf8 934px",
  "#3c87c7 936px",
  "#3982c2 1080px",
  "#3175b5 1430px",
  "#2867a8 1800px",
  "#1f5a9b 2150px",
  "#164c8d 2520px",
  "#144684 2880px",
  "#13417d 3240px",
  "#113d76 3600px",
  "#0e3567 4200px",
].join(",");
const BACKDROP_W = 7000;

const SHRINK_AT = SECTIONS.iceberg.from + 0.08;
const SHRUNK = SHRINK_AT + 0.95;
/** When the cards fall away (the GitHub section). */
export const FALL_AT = SECTIONS.github.from + 0.02;

/** The Mac group's motion: shrinking into the card's sketch, then giving way to it. */
export function macShrink(): Pick<
  GroupLayer,
  "x" | "y" | "scale" | "opacity" | "end" | "origin"
> {
  const s = SKETCH.width / 1280;
  const target: Vec2 = [
    CENTER[0] - SKETCH.width / 2,
    CENTER[1] - (720 * s) / 2,
  ];
  return {
    origin: [0, 0],
    x: [
      [SHRINK_AT, 0],
      [SHRUNK, target[0], "inOutCubic"],
    ],
    y: [
      [SHRINK_AT, 0],
      [SHRUNK, target[1], "inOutCubic"],
    ],
    scale: [
      [SHRINK_AT, 1],
      [SHRUNK, s, "inOutCubic"],
    ],
    opacity: [
      [SHRUNK + 0.1, 1],
      [SHRUNK + 0.55, 0, "inOutSine"],
    ],
    end: SHRUNK + 0.6,
  };
}

/** Cards drifting in, a few at a time, nearest the Mac card first. */
const WAVES: number[][] = [
  [10, 9, 13],
  [7, 8, 11],
  [4, 5, 6, 14],
  [15, 16, 17, 18],
  [0, 1, 2, 3, 19, 20],
];

export function iceberg({ m }: Ctx): Scene {
  const t0 = SECTIONS.iceberg.from; // 52.64
  const end = SECTIONS.iceberg.to; // 58.59
  const rectOfCard = (i: number): Rect => {
    const r = m.stripRects[`${STRIP}/card-${i}`];
    if (!r) throw new Error(`promo-film: no strip rect ${STRIP}/card-${i}`);
    return r;
  };

  const fall = (
    i: number,
    baseY: number,
  ): { y: Key[]; rot: Key[]; out: Key[] } => {
    const at = FALL_AT + rand(i + 300) * 0.25;
    const dir = rand(i + 500) < 0.5 ? -1 : 1;
    return {
      y: [
        [at, baseY],
        [at + 0.75, baseY + 1300, "inCubic"],
      ],
      rot: [
        [at, 0],
        [at + 0.75, dir * (5 + 8 * rand(i + 600)), "inCubic"],
      ],
      out: [
        [at + 0.25, 1],
        [at + 0.6, 0, "inSine"],
      ],
    };
  };

  const cards: Layer[] = [];
  // The Mac card first, under the shrinking Mac.
  {
    const r = rectOfCard(MAC_CARD);
    const baseY = O[1] + r.y;
    const f = fall(MAC_CARD, baseY);
    cards.push(
      stripCrop(m, STRIP, r, O, {
        start: t0,
        end: FALL_AT + 1.5,
        y: f.y,
        rotateZ: f.rot,
        radius: 14,
        shadow: "0 20px 60px rgba(0,0,0,0.35)",
        opacity: [[SHRINK_AT + 0.5, 0], [SHRUNK, 1, "inOutSine"], ...f.out],
      }),
    );
  }
  const sfx: SfxCue[] = [
    { kind: "whoosh", at: SHRINK_AT, dur: 1.0, gain: 0.35, dir: "down" },
  ];
  WAVES.forEach((wave, w) => {
    const at = SHRUNK + 0.25 + w * 0.48;
    sfx.push({ kind: "tick", at: at + 0.3, gain: 0.18 });
    wave.forEach((i, k) => {
      const r = rectOfCard(i);
      const baseY = O[1] + r.y;
      const t = at + k * 0.09;
      const f = fall(i, baseY);
      cards.push(
        stripCrop(m, STRIP, r, O, {
          start: t,
          end: FALL_AT + 1.5,
          y: [[t, baseY + 260], [t + 1.3, baseY, "outCubic"], ...f.y],
          rotateZ: f.rot,
          radius: 14,
          shadow: "0 20px 60px rgba(0,0,0,0.35)",
          opacity: [...fadeIn(t, 0.55), ...f.out],
        }),
      );
    });
  });

  const settle = SHRUNK + 0.25 + WAVES.length * 0.48 + 0.6;
  const pulled: Vec2 = [O[0] + 640, O[1] + 1680];

  const stripOpacity: Key[] = [
    [settle - 0.1, 0],
    [settle + 0.9, 1, "inOutSine"],
    [FALL_AT, 1],
    [FALL_AT + 0.35, 0, "inOutSine"],
  ];
  return {
    underlay: [
      // The iceberg's sky and water carried past the page's edges, so the pulled-back frame is all ocean.
      html(
        `<div style="width:100%;height:100%;background:linear-gradient(to bottom,${WATER})"></div>`,
        BACKDROP_W,
        4200,
        {
          x: O[0] + 640 - BACKDROP_W / 2,
          y: O[1],
          start: SHRUNK - 0.4,
          end: FALL_AT + 0.5,
          opacity: [
            [SHRUNK - 0.4, 0],
            [SHRUNK + 0.4, 1, "inOutSine"],
            [FALL_AT, 1],
            [FALL_AT + 0.35, 0, "inOutSine"],
          ],
        },
      ),
      strip(STRIP, {
        x: O[0],
        y: O[1],
        start: settle - 0.1,
        end: FALL_AT + 0.5,
        opacity: stripOpacity,
      }),
      ...cards,
    ],
    layers: [],
    cam: {
      focus: [
        [SHRUNK, CENTER],
        [end - 0.6, pulled, "inOutSine"],
        [end + 1.5, [pulled[0], pulled[1] + 120], "linear"],
      ],
      zoom: [
        [SHRINK_AT, 1.03],
        [SHRUNK, 1.85, "inOutCubic"],
        [SHRUNK + 0.25, 1.85],
        [end - 0.6, 0.52, "inOutSine"],
        [end + 1.5, 0.48, "linear"],
      ],
      tiltX: [
        [SHRUNK + 0.25, 0],
        [end - 0.6, 10, "inOutSine"],
      ],
    },
    sfx,
  };
}
