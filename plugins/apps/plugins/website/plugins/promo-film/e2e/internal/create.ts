// 33.95–43.29 s · Create any app, still on Places: Wish again → "Create a P2P
// messaging app" types itself → Create → Circle grows out of the Wish popover
// → two variants side by side → each responsive frame narrows into a phone →
// the phones meet and a slider sweeps between the two versions → the dark one
// opens back up to the whole Circle screen (the desktop scene pulls back from it).

import {
  html,
  image,
  rectOf,
  sample,
  sequence,
  typing,
  type Key,
  type Layer,
  type SfxCue,
  type Track,
  type Vec2,
  type Vec4,
} from "@plugins/media/plugins/film/e2e";
import {
  CENTER,
  centerOf,
  cursor,
  fadeIn,
  fadeOut,
  lift,
  placed,
  type Ctx,
  type Scene,
} from "./kit";
import { SECTIONS } from "./timeline";

const PHONE_W = 252;
/** Where the two phones meet: the frame's centre. */
const MEET_X = 640 - PHONE_W / 2;

export function create({ m }: Ctx): Scene {
  const t0 = SECTIONS.create.from; // 33.95
  const end = SECTIONS.create.to; // 43.29
  const wishClick = 34.8;
  const popAt = wishClick + 0.05;
  const createClick = 36.5;
  const growAt = createClick + 0.05;
  const grown = 37.4;
  const pairAt = 38.19;
  const phoneAt = 39.04;
  const meetAt = 39.95;
  const met = 40.65;
  const openAt = 42.45;

  const popover = rectOf(m, "create-wish-popover");
  const createBtn = centerOf(rectOf(m, "create-wish-create"));
  const wishBtn = centerOf(rectOf(m, "wish-button"));
  const seq = m.sequences["create-wish"];
  if (!seq) throw new Error("promo-film: no create-wish sequence");
  const ty = typing(m, "create-wish", 35.3, 36.25, { keyGain: 0.5, seed: 7 });
  const pa = m.stills["circle-pair-a"];
  const pb = m.stills["circle-pair-b"];
  const ppa = m.stills["circle-pair-phone-a"];
  const ppb = m.stills["circle-pair-phone-b"];
  if (!pa || !pb || !ppa || !ppb)
    throw new Error("promo-film: circle pair stills missing");
  // Frame → phone: clip each frame to its phone's width around the same centre.
  const sideA = (pa.width - PHONE_W) / 2;

  // The two phones converge, then the seam S sweeps: a shows left of S, b right of S.
  const ax: Key[] = [
    [meetAt, ppa.x],
    [met, MEET_X, "inOutCubic"],
  ];
  const bx: Key[] = [
    [meetAt, ppb.x],
    [met, MEET_X, "inOutCubic"],
  ];
  const sweep: Key[] = [
    [met, 640],
    [41.35, MEET_X + 10, "inOutSine"],
    [42.05, MEET_X + PHONE_W - 12, "inOutSine"],
    [openAt - 0.05, MEET_X + PHONE_W, "inOutSine"],
  ];
  const seamAt = (t: number): number => {
    if (t >= met) return sample(sweep, t);
    const aR = sample(ax, t) + PHONE_W;
    return (aR + sample(bx, t)) / 2;
  };
  const clipA: Key<Vec4>[] = [];
  const clipB: Key<Vec4>[] = [];
  const seamX: Key[] = [];
  for (let t = meetAt; t <= openAt + 1e-6; t += 1 / 30) {
    const S = seamAt(t);
    const a = sample(ax, t);
    const b = sample(bx, t);
    clipA.push([t, [0, Math.max(0, a + PHONE_W - S), 0, 0]]);
    clipB.push([t, [0, 0, 0, Math.max(0, S - b)]]);
    seamX.push([t, S - 20]);
  }
  const phoneEnd = openAt + 0.5;

  const layers: Layer[] = [
    // Wish again: the action bar over the updated Places, then the popover.
    lift(
      m,
      "places-bar",
      { x: 876, y: 8, width: 396, height: 44 },
      {
        start: t0,
        end: popAt + 0.2,
        opacity: [
          [t0, 0],
          [t0 + 0.25, 1, "inOutSine"],
          [popAt, 1],
          [popAt + 0.2, 0],
        ],
      },
    ),
    lift(
      m,
      "create-popover",
      {
        x: popover.x - 10,
        y: popover.y - 10,
        width: popover.width + 20,
        height: popover.height + 20,
      },
      {
        start: popAt,
        end: popAt + 0.36,
        origin: [popover.width - 40, 10],
        scale: [
          [popAt, 0.92],
          [popAt + 0.35, 1, { spring: { bounce: 0.2 } }],
        ],
        opacity: fadeIn(popAt, 0.14),
      },
    ),
    sequence("create-wish", {
      start: popAt + 0.35,
      end: growAt + 0.3,
      x: seq.clip.x,
      y: seq.clip.y,
      frame: ty.frame,
      opacity: fadeOut(growAt + 0.02, 0.25),
    }),
    // Circle grows out of the popover.
    image("circle-single", {
      start: growAt,
      end: grown + 0.02,
      origin: [0, 0],
      x: [
        [growAt, popover.x],
        [grown, 0, { bezier: [0.2, 0, 0, 1] }],
      ],
      y: [
        [growAt, popover.y],
        [grown, 0, { bezier: [0.2, 0, 0, 1] }],
      ],
      scale: [
        [growAt, popover.width / 1280],
        [grown, 1, { bezier: [0.2, 0, 0, 1] }],
      ],
      radius: 14,
      shadow: "0 40px 100px rgba(0,0,0,0.55)",
      opacity: fadeIn(growAt, 0.16),
    }),
    image("circle-single", {
      start: grown,
      end: pairAt + 0.6,
      opacity: [
        [pairAt, 1],
        [pairAt + 0.4, 0, "inOutSine"],
      ],
    }),
    // Two variants: the pair's chrome and left frame fade in, the right frame slides in.
    image("circle-pair", {
      start: pairAt,
      end: phoneAt + 0.4,
      opacity: fadeIn(pairAt, 0.3),
      clipInset: [
        [pairAt, [0, 1280 - (pb.x - 10), 0, 0]],
        [pairAt + 0.6, [0, 1280 - (pb.x - 10), 0, 0]],
        [pairAt + 0.6, [0, 0, 0, 0], "step"],
      ],
    }),
    placed(m, "circle-pair-b", {
      start: pairAt,
      end: phoneAt,
      x: [
        [pairAt, pb.x + 240],
        [pairAt + 0.6, pb.x, "outQuart"],
      ],
      opacity: fadeIn(pairAt, 0.25),
      shadow: "-20px 0 50px rgba(0,0,0,0.5)",
    }),
    // A dark stage for the phones once the editor chrome goes.
    html(
      `<div style="width:100%;height:100%;background:radial-gradient(ellipse at 50% 45%, #17191f 0%, #0a0b0e 60%, #050506 100%)"></div>`,
      1280,
      720,
      { start: phoneAt + 0.6, end: phoneEnd + 0.3 },
    ),
    image("circle-pair-phone", {
      start: phoneAt,
      end: meetAt,
      opacity: [
        [phoneAt, 0],
        [phoneAt + 0.35, 1, "inOutSine"],
        [phoneAt + 0.65, 1],
        [meetAt - 0.02, 0, "inOutSine"],
      ],
    }),
    // Each frame narrows to its phone's width, then hands over to the phone still.
    ...(["a", "b"] as const).map((k) =>
      placed(m, `circle-pair-${k}`, {
        start: phoneAt,
        end: phoneAt + 0.75,
        clipInset: [
          [phoneAt, [0, 0, 0, 0]],
          [phoneAt + 0.65, [0, sideA, 0, sideA], "inOutCubic"],
        ],
        opacity: fadeOut(phoneAt + 0.45, 0.3),
      }),
    ),
    image("circle-pair-phone-a", {
      start: phoneAt + 0.45,
      end: phoneEnd,
      x: ax,
      y: ppa.y,
      clipInset: clipA,
      opacity: fadeIn(phoneAt + 0.45, 0.3),
    }),
    image("circle-pair-phone-b", {
      start: phoneAt + 0.45,
      end: openAt,
      x: bx,
      y: ppb.y,
      clipInset: clipB,
      opacity: fadeIn(phoneAt + 0.45, 0.3),
    }),
    // The slider: a glowing seam and its handle.
    html(
      `<div style="position:absolute;left:19px;top:0;width:2px;height:100%;background:rgba(255,255,255,0.95);box-shadow:0 0 10px rgba(140,190,255,0.9),0 0 24px rgba(120,170,255,0.6)"></div>
<div style="position:absolute;left:4px;top:${272 - 16}px;width:32px;height:32px;border-radius:50%;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,0.45),0 0 18px rgba(140,190,255,0.7);display:flex;align-items:center;justify-content:center">
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l-6 6 6 6"/><path d="M15 6l6 6-6 6"/></svg></div>`,
      40,
      544,
      {
        start: met - 0.25,
        end: openAt,
        x: seamX,
        y: ppa.y,
        opacity: [
          [met - 0.25, 0],
          [met, 1, "inOutSine"],
          [openAt - 0.25, 1],
          [openAt - 0.02, 0],
        ],
      },
    ),
    // The dark version opens back up into the whole Circle screen.
    image("circle-single", {
      start: openAt,
      end,
      clipInset: [
        [
          openAt,
          [
            ppa.y,
            1280 - (MEET_X + PHONE_W),
            720 - (ppa.y + ppa.height),
            MEET_X,
          ],
        ],
        [end - 0.05, [0, 0, 0, 0], "inOutCubic"],
      ],
      clipRadius: 14,
      opacity: fadeIn(openAt, 0.3),
    }),
    cursor(
      [
        [t0, 1040, 420],
        [34.7, wishBtn[0], wishBtn[1]],
        [35.3, wishBtn[0], wishBtn[1]],
        [36.4, createBtn[0], createBtn[1]],
      ],
      [wishClick, createClick],
      createClick + 0.15,
    ),
  ];

  const zoomPhones: Track = [
    [grown, 1],
    [pairAt, 1.03, "inOutSine"],
    [pairAt + 0.6, 1, "inOutSine"],
    [meetAt, 1],
    [met, 1.22, "inOutCubic"],
    [openAt, 1.24],
    [end, 1, "inOutCubic"],
  ];
  const phoneFocus: Vec2 = [640, ppa.y + ppa.height / 2];

  const sfx: SfxCue[] = [
    { kind: "pop", at: t0 + 0.05, pitch: -2, gain: 0.3 },
    { kind: "click", at: wishClick },
    { kind: "pop", at: popAt + 0.03, pitch: 2, gain: 0.5 },
    ...ty.cues,
    { kind: "click", at: createClick },
    { kind: "whoosh", at: growAt, dur: 0.85, gain: 0.45, dir: "up" },
    { kind: "pop", at: grown - 0.05, pitch: -3, gain: 0.35 },
    { kind: "whoosh", at: pairAt, dur: 0.55, gain: 0.28 },
    { kind: "whoosh", at: phoneAt, dur: 0.6, gain: 0.25, dir: "down" },
    { kind: "tick", at: met, gain: 0.4 },
    { kind: "riser", at: meetAt, dur: end - meetAt, gain: 0.4 },
    { kind: "whoosh", at: openAt, dur: 0.8, gain: 0.3, dir: "up" },
  ];

  return {
    layers,
    cam: {
      focus: [
        [t0, CENTER],
        [meetAt, CENTER],
        [met, phoneFocus, "inOutCubic"],
        [openAt, phoneFocus],
        [end, CENTER, "inOutCubic"],
      ],
      zoom: zoomPhones as Key[],
    },
    sfx,
  };
}
