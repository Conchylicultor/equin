// 0–9.3 s · Start + Any app. The Home gallery tilted in the dark, found by a
// light sweep; it settles flat, its app icons lift onto depth layers and drift
// with parallax, snap back in a ripple from the Pages icon, which rises, and
// the camera dives into it — landing on the Pages page the next section opens on.

import {
  group,
  image,
  shape,
  type ImageLayer,
  type Key,
  type Layer,
  type SfxCue,
  type Vec2,
} from "@plugins/media/plugins/film/e2e";
import { CENTER, centerOf, rand, type Ctx, type Scene } from "./kit";
import { SECTIONS } from "./timeline";

/** The 3D rig's perspective: the tilt and the icons' depth project through it. */
const PERSPECTIVE = 1600;
/** How much the Pages page is scaled when it sits inside the icon (≈ the icon's width). */
const PAGE_IN_ICON = 0.065;
/** How far the camera dives into the icon; the page grows out of it the rest of the way (a 72 px icon zoomed further only blurs). */
const DIVE_ZOOM = 3.2;
/** The page's scale right after the dive; the integrated scene settles it to 1. */
export const LANDING_SCALE = 1.12;

const TILES = [
  "agent-manager",
  "browser",
  "chord",
  "debug",
  "demo",
  "deploy",
  "desktop",
  "events",
  "file-explorer",
  "keyboard-party",
  "mail",
  "pages",
  "places",
  "prototypes",
  "settings",
  "sonata",
  "studio",
  "website",
];

export function intro({ m }: Ctx): Scene {
  const t3 = SECTIONS.anyApp.from; // 3.35: the tilt resolves, first pulse
  const end = SECTIONS.anyApp.to; // 9.30: inside the Pages icon
  const flat = t3 + 1.0;
  const liftAt = flat - 0.15;
  const driftEnd = 7.2;
  const rippleAt = 7.0;
  const riseAt = 7.8;
  const riseEnd = 8.35;
  const diveAt = 8.4;

  const pagesTile = m.stills["tile-pages-icon"];
  if (!pagesTile) throw new Error("promo-film: no tile-pages-icon still");
  const pagesC = centerOf(pagesTile);
  const PAGES_Z = 80;
  const PAGES_SCALE = 1.08;
  // Where the risen Pages icon projects (the rig is flat by then).
  const f = PERSPECTIVE / (PERSPECTIVE - PAGES_Z);
  const P: Vec2 = [
    CENTER[0] + (pagesC[0] - CENTER[0]) * f,
    CENTER[1] + (pagesC[1] - CENTER[1]) * f,
  ];

  const sfx: SfxCue[] = [
    { kind: "whoosh", at: liftAt, dur: 0.9, gain: 0.3, dir: "up" },
    { kind: "whoosh", at: diveAt + 0.15, dur: 0.75, gain: 0.45, dir: "up" },
  ];
  const ticks = new Set<number>();

  const tiles: ImageLayer[] = TILES.map((name, i) => {
    const s = m.stills[`tile-${name}`];
    if (!s) throw new Error(`promo-film: no tile-${name} still`);
    const c = centerOf(s);
    const isPages = name === "pages";
    const d = Math.hypot(c[0] - pagesC[0], c[1] - pagesC[1]);
    const z = 70 + rand(i) * 200;
    const up = liftAt + 0.08 * rand(i + 40);
    const snap = rippleAt + (d / 1000) * 0.7;
    ticks.add(Math.round(snap * 10) / 10);
    const zKeys: Key[] = [
      [up, 0],
      [up + 0.95, z, "outCubic"],
      [snap, z + 25 * rand(i + 7)],
      // Snaps down into the plane (never past it: the gallery would hide it)…
      [snap + 0.3, 0, "inCubic"],
    ];
    if (isPages) zKeys.push([riseAt, 0], [riseEnd, PAGES_Z, "outCubic"]);
    const tilt = (rand(i + 90) - 0.5) * 12;
    return image(`tile-${name}`, {
      id: `intro-tile-${name}`,
      x: s.x,
      y: s.y,
      z: zKeys,
      rotateY: [
        [up, 0],
        [up + 0.95, tilt, "outCubic"],
        [snap, tilt],
        [snap + 0.3, 0, "inCubic"],
      ],
      // …and lands with a small press and spring.
      scale: [
        [snap + 0.3, 1],
        [snap + 0.38, 0.92, "outQuad"],
        [snap + 0.75, 1, { spring: { bounce: 0.4 } }],
        ...(isPages
          ? ([
              [riseAt, 1],
              [riseEnd, PAGES_SCALE, "outCubic"],
            ] as Key[])
          : []),
      ],
      opacity: isPages
        ? 1
        : [
            [diveAt, 1],
            [diveAt + 0.5, 0.25, "inSine"],
          ],
    });
  });
  // Soft ticks as the ripple ring passes (a handful, not one per icon).
  [...ticks]
    .sort((a, b) => a - b)
    .filter((_, i) => i % 2 === 0)
    .slice(0, 5)
    .forEach((t, i) =>
      sfx.push({ kind: "tick", at: t + 0.12, gain: 0.32 - i * 0.04 }),
    );

  const gallery = group(
    [
      image("home-empty", {
        z: -2,
        radius: 18,
        style: { outline: "1px solid rgba(255,255,255,0.10)" },
        shadow: "0 60px 160px rgba(0,0,0,0.9)",
        opacity: [
          [diveAt, 1],
          [diveAt + 0.5, 0.3, "inSine"],
        ],
      }),
      ...tiles,
      // The light that finds the gallery's edge.
      shape(
        {
          kind: "sweep",
          width: 1280,
          height: 720,
          progress: [
            [0.2, 0],
            [3.3, 1, "inOutSine"],
          ],
          band: 360,
          angle: 24,
          color: "rgba(190,210,255,0.20)",
          radius: 18,
        },
        {
          blend: "screen",
          end: t3 + 0.6,
          opacity: [
            [t3, 1],
            [t3 + 0.6, 0],
          ],
        },
      ),
    ],
    {
      id: "intro-gallery",
      width: 1280,
      height: 720,
      style: { "transform-style": "preserve-3d" },
      rotateX: [
        [0, 16],
        [t3, 13],
        [flat, 0, "inOutCubic"],
        [flat + 0.6, 0],
        [flat + 1.4, 5, "inOutSine"],
        [driftEnd, -3, "inOutSine"],
        [rippleAt + 0.4, 0, "inOutSine"],
      ],
      rotateY: [
        [0, -14],
        [t3, -11],
        [flat, 0, "inOutCubic"],
        [flat + 0.6, 0],
        [flat + 1.5, -10, "inOutSine"],
        [driftEnd, 8, "inOutSine"],
        [rippleAt + 0.5, 0, "inOutSine"],
      ],
      rotateZ: [
        [0, -5],
        [t3, -4],
        [flat, 0, "inOutCubic"],
      ],
      opacity: [
        [0, 0],
        [1.8, 0.75, "inOutSine"],
        [t3 - 0.3, 1, "inOutSine"],
      ],
    },
  );

  const layers: Layer[] = [
    group([gallery], {
      width: 1280,
      height: 720,
      perspective: PERSPECTIVE,
      end,
    }),
    // The page, inside the risen icon, that the dive lands on.
    image("chain-page", {
      id: "intro-page-in-icon",
      start: diveAt + 0.2,
      end,
      x: P[0] - 640,
      y: P[1] - 360,
      scale: [
        [diveAt + 0.2, PAGE_IN_ICON],
        [end, LANDING_SCALE / DIVE_ZOOM, { bezier: [0.55, 0, 0.9, 0.6] }],
      ],
      radius: 20,
      opacity: [
        [diveAt + 0.35, 0],
        [end - 0.2, 1, "inOutSine"],
      ],
    }),
  ];

  return {
    layers,
    cam: {
      focus: [
        [0, CENTER],
        [diveAt, CENTER],
        [diveAt + 0.55, P, "inOutCubic"],
        [end, P],
        [end, CENTER, "step"],
      ],
      zoom: [
        [0, 0.74],
        [t3, 0.84, "inOutSine"],
        [flat, 1, "inOutCubic"],
        [diveAt, 1],
        [end, DIVE_ZOOM, { bezier: [0.55, 0, 0.9, 0.6] }],
        [end, 1, "step"],
      ],
    },
    sfx,
  };
}
