// 9.3–21.2 s · All integrated, one shot: a Pages wiki page → a conversation
// link opens the agent manager conversation as a side pane → it takes the
// frame → its files button opens the file tree beside it → that takes the
// frame → a .mid file opens its Sonata preview → "Open in Sonata" grows Sonata
// out of the preview, and it plays (its own piano is the soundtrack).

import {
  image,
  sequence,
  type Layer,
  type PlacedClip,
  type SfxCue,
  type Vec2,
} from "@plugins/media/plugins/film/e2e";
import {
  CENTER,
  cursor,
  dim,
  paneArrive,
  paneFill,
  type Ctx,
  type Scene,
} from "./kit";
import { LANDING_SCALE } from "./intro";
import { SECTIONS } from "./timeline";

/** Sonata's playback, film seconds: the sequence and its own sound start together. */
export const SONATA_PLAY = 19.45;

export function integrated({ m }: Ctx): Scene {
  const t0 = SECTIONS.integrated.from; // 9.30
  const end = SECTIONS.integrated.to; // 21.20

  // Pages → conversation side pane → conversation fills the frame.
  const click1 = 11.0;
  const arrive1 = click1 + 0.05;
  const fill1 = 12.7;
  // Conversation → file tree side pane → Files fills the frame.
  const click2 = 14.4;
  const arrive2 = click2 + 0.05;
  const fill2 = 15.95;
  // A .mid row → its Sonata preview → Open in Sonata → Sonata.
  const click3 = 17.38;
  const arrive3 = click3 + 0.04;
  const click4 = 18.65;
  const fill4 = click4 + 0.07;
  const followA: Vec2 = [860, 360];
  const followB: Vec2 = [900, 360];

  const layers: Layer[] = [
    image("chain-page", {
      start: t0,
      end: arrive1 + 0.72,
      scale: [
        [t0, LANDING_SCALE],
        [t0 + 0.9, 1, "outCubic"],
      ],
    }),
    ...paneArrive(m, "chain-page-conv", 985, arrive1, fill1),
    dim(
      { x: 0, y: 0, width: 985, height: 720 },
      [
        [11.9, 0],
        [fill1, 0.3, "inOutSine"],
      ],
      11.9,
      fill1,
    ),
    ...paneFill(
      m,
      "chain-page-conv",
      "chain-conv",
      985,
      fill1,
      0.85,
      arrive2 + 0.75,
      0.3,
    ),
    ...paneArrive(m, "chain-conv-files", 866, arrive2, fill2),
    dim(
      { x: 0, y: 0, width: 866, height: 720 },
      [
        [15.25, 0],
        [fill2, 0.3, "inOutSine"],
      ],
      15.25,
      fill2,
    ),
    ...paneFill(
      m,
      "chain-conv-files",
      "chain-files",
      866,
      fill2,
      0.85,
      arrive3 + 0.65,
      0.3,
    ),
    ...paneArrive(m, "chain-files-mid", 727, arrive3, fill4, 0.6),
    ...paneFill(
      m,
      "chain-files-mid",
      "sonata",
      727,
      fill4,
      0.75,
      SONATA_PLAY + 0.05,
    ),
    sequence("sonata-play", {
      start: SONATA_PLAY,
      end,
      playFrom: SONATA_PLAY,
    }),
    cursor(
      [
        [9.95, 1180, 690],
        [10.85, 696, 384],
      ],
      [click1],
      click1 + 0.2,
    ),
    cursor(
      [
        [13.55, 1010, 560],
        [14.3, 980, 62],
      ],
      [click2],
      click2 + 0.2,
    ),
    cursor(
      [
        [16.6, 900, 620],
        [17.25, 560, 427],
        [17.62, 560, 427],
        [18.5, 1194, 95],
      ],
      [click3, click4],
      click4 + 0.15,
    ),
  ];

  const sfx: SfxCue[] = [
    { kind: "click", at: click1 },
    { kind: "whoosh", at: arrive1, dur: 0.6, gain: 0.3 },
    { kind: "whoosh", at: fill1, dur: 0.8, gain: 0.22 },
    { kind: "click", at: click2 },
    { kind: "whoosh", at: arrive2, dur: 0.6, gain: 0.3 },
    { kind: "whoosh", at: fill2, dur: 0.8, gain: 0.22 },
    { kind: "click", at: click3 },
    { kind: "whoosh", at: arrive3, dur: 0.5, gain: 0.22 },
    { kind: "click", at: click4 },
    { kind: "whoosh", at: fill4, dur: 0.7, gain: 0.3, dir: "up" },
  ];
  const clips: PlacedClip[] = [
    // The clip's dense part starts ~2 s in: skip its opening rest.
    {
      audio: "sonata",
      at: SONATA_PLAY,
      offset: 1.85,
      duration: end - SONATA_PLAY + 0.15,
      fadeIn: 0.04,
      gainDb: -3,
      fadeOut: 0.3,
    },
  ];

  return {
    layers,
    cam: {
      focus: [
        [t0, CENTER],
        [arrive1 + 0.7, CENTER],
        [fill1, followA, "inOutSine"],
        [fill1 + 0.85, CENTER, "inOutCubic"],
        [arrive2 + 0.7, CENTER],
        [fill2, followB, "inOutSine"],
        [fill2 + 0.85, CENTER, "inOutCubic"],
        [end, CENTER],
      ],
      zoom: [
        [t0, 1],
        [arrive1 + 0.7, 1],
        [fill1, 1.08, "inOutSine"],
        [fill1 + 0.85, 1, "inOutCubic"],
        [arrive2 + 0.7, 1],
        [fill2, 1.08, "inOutSine"],
        [fill2 + 0.85, 1, "inOutCubic"],
        [SONATA_PLAY, 1],
        [end, 1.06, "linear"],
      ],
    },
    sfx,
    clips,
  };
}
