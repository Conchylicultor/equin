// Free and open source, then the end card. As the iceberg's cards fall away
// the GitHub mark appears with the repository; then, in the website's own
// theme, "equin." in the centre and ".ai" growing out of the dot.
//
// The end card is centred by LAYOUT, not by a measured offset: one flex row,
// centred, holding "equin." and an "ai" whose box grows from zero to its own
// width (`calc-size(max-content, size * p)`), so the browser recentres the
// whole word every frame — "equin." centred alone at first, "equin.ai"
// centred at the end, exactly, whatever the font's metrics.

import { SOURCE_REPO } from "@plugins/framework/plugins/product-name/core";
import {
  html,
  shape,
  type Key,
  type SfxCue,
} from "@plugins/media/plugins/film/e2e";
import { fadeInOut, H, SITE, W, type Scene } from "./kit";

const GITHUB_MARK = `<svg width="64" height="64" viewBox="0 0 16 16" fill="${SITE.fg}"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

const WORD_SIZE = 132;

const END_CARD = `<div style="width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center;font:700 ${WORD_SIZE}px/1.15 'Inter Variable',Inter,sans-serif;letter-spacing:-0.045em;color:${SITE.fg};white-space:nowrap">
<span style="display:inline-block;opacity:var(--a);filter:blur(calc((1 - var(--a)) * 12px));transform:translateY(calc((1 - var(--a)) * 14px))">equin<span style="color:${SITE.azure}">.</span></span><span style="display:inline-block;overflow:clip;overflow-clip-margin:0.2em;width:calc-size(max-content, size * var(--p))"><span style="display:inline-block;opacity:var(--q);filter:blur(calc((1 - var(--q)) * 10px));transform:translateX(calc((1 - var(--q)) * -22px))">ai</span></span></div>`;

export interface OutroTimes {
  /** The GitHub card appears (the iceberg's cards are falling). */
  github: number;
  /** The end card starts. */
  end: number;
  /** The film's last instant. */
  duration: number;
}

export function outro({ github, end, duration }: OutroTimes): Scene {
  const aiAt = end + 0.95;
  const fadeAt = duration - 1.1;
  const a: Key[] = [
    [end + 0.02, 0],
    [end + 0.75, 1, "outCubic"],
  ];
  const p: Key[] = [
    [aiAt - 0.1, 0],
    [aiAt + 0.55, 1, "inOutCubic"],
  ];
  const q: Key[] = [
    [aiAt, 0],
    [aiAt + 0.6, 1, "outCubic"],
  ];
  const sfx: SfxCue[] = [];
  return {
    layers: [],
    overlay: [
      html(
        `<div style="width:${W}px;height:${H}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px">
${GITHUB_MARK}
<div style="font:600 30px 'Inter Variable',Inter,sans-serif;letter-spacing:-0.01em;color:${SITE.fg}">Free and open source</div>
<div style="font:500 22px 'Inter Variable',Inter,sans-serif;letter-spacing:-0.01em;color:${SITE.muted}">github.com/${SOURCE_REPO}</div></div>`,
        W,
        H,
        {
          start: github,
          end,
          origin: [W / 2, H / 2],
          scale: [
            [github, 0.97],
            [github + 0.8, 1, "outCubic"],
          ],
          opacity: fadeInOut(github, 0.4, end - 0.3, 0.28),
        },
      ),
      // The site's background under the end card.
      shape(
        { kind: "rect", width: W, height: H, fill: SITE.bg },
        {
          start: end - 0.3,
          opacity: [
            [end - 0.3, 0],
            [end, 1, "inOutSine"],
          ],
        },
      ),
      html(END_CARD, W, H, { start: end, vars: { a, p, q } }),
      shape(
        { kind: "rect", width: W, height: H, fill: "#000" },
        {
          start: fadeAt,
          opacity: [
            [fadeAt, 0],
            [duration, 1, "inSine"],
          ],
        },
      ),
    ],
    sfx,
  };
}
