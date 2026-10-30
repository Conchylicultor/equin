// 58.59–64 s · Free and open source, then the end card. As the iceberg's cards
// fall away the GitHub mark appears with the repository; then, in the
// website's own theme, "equin." in the centre, ".ai" sliding in after the dot,
// one deep hit, a long tail, and a fade to black.

import { SOURCE_REPO } from "@plugins/framework/plugins/product-name/core";
import {
  html,
  shape,
  text,
  type SfxCue,
} from "@plugins/media/plugins/film/e2e";
import { fadeInOut, SITE, type Ctx, type Scene } from "./kit";
import { SECTIONS } from "./timeline";

const GITHUB_MARK = `<svg width="64" height="64" viewBox="0 0 16 16" fill="${SITE.fg}"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

const WORD_SIZE = 132;
/** Half the width of "ai" at WORD_SIZE (Inter Bold, tight tracking): the wordmark recentres as it arrives. */
const AI_HALF = 44;

export function outro(_ctx: Ctx): Scene {
  const gh = SECTIONS.github.from + 0.85; // after the cards start falling
  const t0 = SECTIONS.end.from; // 60.29
  const aiAt = t0 + 0.95;
  const fadeAt = 62.9;
  const recentre = [
    [aiAt - 0.1, AI_HALF],
    [aiAt + 0.55, 0, "inOutCubic"],
  ] as const;
  const wordBase = {
    size: WORD_SIZE,
    weight: 700,
    width: 1280,
    align: "center" as const,
    y: 360 - WORD_SIZE * 0.62,
    letterSpacing: "-0.045em",
    lineHeight: 1.15,
    start: t0,
    x: [...recentre],
  };
  const sfx: SfxCue[] = [
    {
      kind: "whoosh",
      at: SECTIONS.github.from + 0.02,
      dur: 0.9,
      gain: 0.3,
      dir: "down",
    },
    { kind: "impact", at: t0, gain: 1 },
  ];
  return {
    layers: [],
    overlay: [
      html(
        `<div style="width:1280px;height:720px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px">
${GITHUB_MARK}
<div style="font:500 24px 'Inter Variable',Inter,sans-serif;letter-spacing:-0.01em;color:${SITE.muted}">github.com/${SOURCE_REPO}</div></div>`,
        1280,
        720,
        {
          start: gh,
          end: t0,
          origin: [640, 360],
          scale: [
            [gh, 0.97],
            [gh + 0.8, 1, "outCubic"],
          ],
          opacity: fadeInOut(gh, 0.4, t0 - 0.3, 0.28),
        },
      ),
      // The site's background under the end card.
      shape(
        { kind: "rect", width: 1280, height: 720, fill: SITE.bg },
        {
          start: t0 - 0.3,
          opacity: [
            [t0 - 0.3, 0],
            [t0, 1, "inOutSine"],
          ],
        },
      ),
      text(
        [
          { text: "equin" },
          { text: ".", style: { color: SITE.azure } },
          { text: "ai", style: { color: "transparent" } },
        ],
        {
          ...wordBase,
          color: SITE.fg,
          reveal: {
            by: "letter",
            at: t0 + 0.02,
            stagger: 0.045,
            duration: 0.7,
            fromY: 14,
            fromBlur: 12,
          },
        },
      ),
      text(
        [
          { text: "equin.", style: { color: "transparent" } },
          { text: "ai", style: { color: SITE.fg } },
        ],
        {
          ...wordBase,
          color: SITE.fg,
          reveal: {
            by: "letter",
            at: aiAt - 6 * 0.07,
            stagger: 0.07,
            duration: 0.55,
            fromX: -22,
            fromBlur: 10,
          },
        },
      ),
      shape(
        { kind: "rect", width: 1280, height: 720, fill: "#000" },
        {
          start: fadeAt,
          opacity: [
            [fadeAt, 0],
            [64, 1, "inSine"],
          ],
        },
      ),
    ],
    sfx,
  };
}
