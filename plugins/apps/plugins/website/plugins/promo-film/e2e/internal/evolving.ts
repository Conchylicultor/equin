// 22.05–33.95 s · Evolving, on the same Places screen: the action bar shows,
// Pick UI element → the hover outline jumps across elements → a place card is
// picked → the Wish popover opens with the element chip and the request
// types itself → Create → a shimmer → the cards update in place under a light
// sweep (opening hours under each place) → spotlight and a punch-in on the
// picked card, then back.

import {
  group,
  image,
  inflate,
  rectOf,
  rectV,
  sequence,
  shape,
  typing,
  type Key,
  type Layer,
  type Rect,
  type RectV,
  type SfxCue,
  type Vec2,
} from "@plugins/media/plugins/film/e2e";
import {
  CENTER,
  centerOf,
  cursor,
  fadeIn,
  lift,
  type Ctx,
  type Scene,
} from "./kit";
import { PLACES_CUT } from "./more-apps";
import { SECTIONS } from "./timeline";

/** places.png carries a setup banner top-centre; places-bar has plain map chrome there. */
const BANNER_PATCH: Rect = { x: 515, y: 0, width: 248, height: 46 };

/** The Places screen as first captured, its setup banner covered. */
export function placesBase(m: Ctx["m"], start: number, end: number): Layer {
  return group([image("places"), lift(m, "places-bar", BANNER_PATCH)], {
    start,
    end,
    width: 1280,
    height: 720,
  });
}

/** The cards updated (opening hours) are revealed at this time; create.ts keeps them. */
export const AFTER_AT = 31.5;
export const AFTER_CARD = "places-after-card-3";

export function evolving({ m }: Ctx): Scene {
  const end = SECTIONS.evolving.to; // 33.95
  const barAt = 24.8;
  const pickClick = 25.45;
  const pickedClick = 28.0;
  const popAt = pickedClick + 0.05;
  const typeFrom = 28.55;
  const typeTo = 30.15;
  const createClick = 30.55;
  const closeAt = createClick + 0.07;
  const doneAt = 32.1;

  // Hover targets, in order, and when the outline reaches each.
  const hovers: Array<{ still: string; rect: Rect; at: number }> = [
    { still: "pick-search", rect: rectOf(m, "pick-search-target"), at: 25.72 },
    { still: "pick-preset", rect: rectOf(m, "pick-preset-target"), at: 26.18 },
    { still: "pick-tag", rect: rectOf(m, "pick-tag-target"), at: 26.62 },
    { still: "pick-card", rect: rectOf(m, "pick-card-target"), at: 27.08 },
    { still: "pick-picked", rect: rectOf(m, "pick-picked-target"), at: 27.52 },
  ];
  const hoverLayers: Layer[] = hovers.map((h, i) =>
    image(h.still, {
      start: i === 0 ? pickClick + 0.1 : h.at - 0.04,
      end:
        i + 1 < hovers.length
          ? (hovers[i + 1] as { at: number }).at - 0.04
          : popAt,
    }),
  );
  const ringRect = (r: Rect): RectV => rectV(inflate(r, 5));
  // The outline holds on a target, then jumps (fast, eased) to the next.
  const ring: Key<RectV>[] = [[pickClick + 0.1, ringRect(hovers[0]!.rect)]];
  hovers.slice(1).forEach((h, i) => {
    ring.push([h.at - 0.04, ringRect(hovers[i]!.rect)]);
    ring.push([h.at + 0.08, ringRect(h.rect), "outCubic"]);
  });
  const ringPart = (k: 0 | 1 | 2 | 3): Key[] =>
    ring.map(([t, v, e]): Key => (e === undefined ? [t, v[k]] : [t, v[k], e]));

  const popover = rectOf(m, "places-wish-popover");
  const createBtn = centerOf(rectOf(m, "places-wish-create"));
  const ty = typing(m, "places-wish", typeFrom, typeTo, {
    keyGain: 0.5,
    seed: 3,
  });
  const seq = m.sequences["places-wish"];
  if (!seq) throw new Error("promo-film: no places-wish sequence");
  const list: Rect = { x: 900, y: 100, width: 380, height: 620 };
  const card = rectOf(m, AFTER_CARD);
  // Punch-in focus, kept inside the frame's right edge at this zoom.
  const PUNCH = 1.75;
  const punchFocus: Vec2 = [
    Math.min(centerOf(card)[0], 1280 - 640 / PUNCH),
    centerOf(card)[1],
  ];

  const layers: Layer[] = [
    placesBase(m, PLACES_CUT, barAt + 0.25),
    image("places-bar", {
      start: barAt,
      end: pickClick + 0.12,
      opacity: fadeIn(barAt, 0.2),
    }),
    ...hoverLayers,
    shape(
      {
        kind: "ring",
        width: ringPart(2),
        height: ringPart(3),
        color: "oklch(0.7971 0.1339 211.53)",
        radius: 6,
        thickness: 2,
        glow: 16,
      },
      {
        start: pickClick + 0.1,
        end: pickedClick + 0.3,
        x: ringPart(0),
        y: ringPart(1),
        opacity: [
          [pickClick + 0.1, 0],
          [pickClick + 0.25, 1],
          [pickedClick, 1],
          [pickedClick + 0.25, 0],
        ],
      },
    ),
    placesBase(m, popAt - 0.02, AFTER_AT + 0.62),
    lift(m, "places-picked", inflate(popover, 10), {
      start: popAt,
      end: popAt + 0.36,
      origin: [popover.width - 40, 10],
      scale: [
        [popAt, 0.92],
        [popAt + 0.35, 1, { spring: { bounce: 0.2 } }],
      ],
      opacity: fadeIn(popAt, 0.14),
    }),
    sequence("places-wish", {
      start: popAt + 0.35,
      end: closeAt + 0.3,
      x: seq.clip.x,
      y: seq.clip.y,
      frame: ty.frame,
      origin: [seq.clip.width - 40, 10],
      scale: [
        [closeAt, 1],
        [closeAt + 0.25, 0.96, "inCubic"],
      ],
      opacity: [
        [closeAt, 1],
        [closeAt + 0.25, 0, "inCubic"],
      ],
    }),
    // Working: two soft passes of light over the list.
    ...[0, 0.42].map((d) =>
      shape(
        {
          kind: "sweep",
          width: list.width,
          height: list.height,
          progress: [
            [closeAt + 0.1 + d, 0],
            [closeAt + 0.75 + d, 1, "inOutSine"],
          ],
          band: 160,
          angle: 14,
          color: "rgba(110,160,255,0.28)",
        },
        {
          x: list.x,
          y: list.y,
          start: closeAt + 0.1 + d,
          end: closeAt + 0.76 + d,
        },
      ),
    ),
    // The updated cards, revealed left → right under a bright band.
    image("places-after", {
      start: AFTER_AT,
      end: end + 3.7,
      clipInset: [
        [AFTER_AT, [0, 1280 - list.x, 0, list.x]],
        [doneAt, [0, 0, 0, list.x], "inOutCubic"],
        [doneAt, [0, 0, 0, 0], "step"],
      ],
    }),
    shape(
      {
        kind: "sweep",
        width: list.width,
        height: list.height,
        progress: [
          [AFTER_AT - 0.05, 0],
          [doneAt + 0.05, 1, "inOutCubic"],
        ],
        band: 120,
        angle: 0,
        color: "rgba(255,255,255,0.55)",
      },
      {
        x: list.x,
        y: list.y,
        start: AFTER_AT - 0.05,
        end: doneAt + 0.06,
        blend: "screen",
      },
    ),
    shape(
      {
        kind: "spotlight",
        hole: rectV(inflate(card, 6)),
        radius: 12,
        feather: 26,
        color: "rgba(0,0,0,0.5)",
      },
      {
        start: doneAt,
        end,
        opacity: [
          [doneAt + 0.05, 0],
          [doneAt + 0.4, 1, "inOutSine"],
          [33.25, 1],
          [33.85, 0, "inOutSine"],
        ],
      },
    ),
    cursor(
      [
        [24.3, 880, 560],
        [25.3, 1250, 29],
        [hovers[0]!.at, ...centerOf(hovers[0]!.rect)],
        [hovers[1]!.at, ...centerOf(hovers[1]!.rect)],
        [hovers[2]!.at, ...centerOf(hovers[2]!.rect)],
        [hovers[3]!.at, ...centerOf(hovers[3]!.rect)],
        [hovers[4]!.at, ...centerOf(hovers[4]!.rect)],
      ],
      [pickClick, pickedClick],
      pickedClick + 0.15,
    ),
    cursor(
      [
        [29.85, 1130, 420],
        [30.45, createBtn[0], createBtn[1]],
      ],
      [createClick],
      createClick + 0.2,
    ),
  ];

  const sfx: SfxCue[] = [
    { kind: "pop", at: barAt, pitch: -2, gain: 0.35 },
    { kind: "click", at: pickClick },
    ...hovers
      .slice(1)
      .map((h): SfxCue => ({ kind: "tick", at: h.at, gain: 0.3 })),
    { kind: "click", at: pickedClick },
    { kind: "pop", at: popAt + 0.03, pitch: 3, gain: 0.5 },
    ...ty.cues,
    { kind: "click", at: createClick },
    { kind: "shimmer", at: closeAt + 0.05, dur: 1.1, gain: 0.55 },
    { kind: "whoosh", at: AFTER_AT, dur: 0.6, gain: 0.18 },
    { kind: "chime", at: doneAt, gain: 0.7 },
    { kind: "whoosh", at: doneAt + 0.02, dur: 0.5, gain: 0.18 },
  ];

  return {
    layers,
    cam: {
      focus: [
        [doneAt, CENTER],
        [doneAt + 0.6, punchFocus, "outCubic"],
        [33.25, punchFocus],
        [end, CENTER, "inOutCubic"],
      ],
      zoom: [
        [doneAt, 1],
        [doneAt + 0.6, PUNCH, "outCubic"],
        [33.25, PUNCH + 0.03],
        [end, 1, "inOutCubic"],
      ],
    },
    sfx,
  };
}
