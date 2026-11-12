// The title card and the end card mirror each other — the same typography on
// the same background, revealed the same way: one line fades and rises in,
// then a part grows out of it while the browser recentres the line. The film
// opens on "A personal OS", and "self-evolving" grows into its place in the
// phrase — "A self-evolving personal OS" — painted in the website homepage's
// accent gradient (azure → cyan through the glyphs, as the homepage paints
// "evolves on request"); it closes on "equin." with ".ai" growing out of the
// dot.
//
// The end card: in the website's own theme, "equin." in the centre and ".ai"
// growing out of the dot — the brand is equin.ai — and under it, small, "Free
// and open source". No URL: nothing on screen is an address to type.
//
// A line is centred by LAYOUT, not by a measured offset: one flex row,
// centred, whose growing part's box grows from zero to its own width
// (`calc-size(max-content, size * p)`), so the browser recentres the whole
// line every frame — "equin." centred alone at first, "equin.ai" centred at
// the end, exactly, whatever the font's metrics.

import {
  html,
  shape,
  type Key,
  type SfxCue,
} from "@plugins/media/plugins/film/e2e";
import { H, SITE, W, type Scene } from "./kit";

const WORD_SIZE = 132;

const END_CARD = growingLine({
  before: `equin<span style="color:${SITE.azure}">.</span>`,
  grown: "ai",
  size: WORD_SIZE,
});

const TITLE_SIZE = 72;

/**
 * A line a part grows into: `before` and `after` fade and rise in (`--a`),
 * then `grown`'s box grows from zero to its own width between them (`--p`),
 * the browser recentring the whole line every frame, while its text slides
 * in (`--q`). The end card grows ".ai" at the end of "equin."; the title
 * grows "self-evolving" inside "A personal OS".
 */
function growingLine({
  before,
  grown,
  after = "",
  size,
}: {
  before: string;
  grown: string;
  after?: string;
  size: number;
}): string {
  const shown = (text: string): string =>
    text === ""
      ? ""
      : `<span style="display:inline-block;white-space:pre;opacity:var(--a);filter:blur(calc((1 - var(--a)) * 12px));transform:translateY(calc((1 - var(--a)) * 14px))">${text}</span>`;
  return `<div style="width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center;font:700 ${size}px/1.15 'Inter Variable',Inter,sans-serif;letter-spacing:-0.045em;color:${SITE.fg};white-space:nowrap">
${shown(before)}<span style="display:inline-block;overflow:clip;overflow-clip-margin:0.2em;width:calc-size(max-content, size * var(--p))"><span style="display:inline-block;white-space:pre;opacity:var(--q);filter:blur(calc((1 - var(--q)) * 10px));transform:translateX(calc((1 - var(--q)) * -22px))">${grown}</span></span>${shown(after)}</div>`;
}

/**
 * Painted in the website homepage's accent (`website-hero.css` `.website-hero-accent`):
 * the azure → cyan gradient painted through the glyphs.
 */
function accent(words: string): string {
  return `<span style="background-image:linear-gradient(90deg, ${SITE.azure}, ${SITE.cyan});-webkit-background-clip:text;background-clip:text;color:transparent">${words}</span>`;
}

/**
 * The reveal's keys from `at`: the first part, then the second growing out of
 * it — one tempo for both cards (they share it): the first part lands in
 * 0.6 s, the growing starts {@link GROW_DELAY} after `at` (the first part read
 * alone ~0.2 s, never a dead wait), its box opens over 0.65 s and its words
 * come in over 0.6 s.
 */
function revealKeys(
  at: number,
  {
    growAt = at + GROW_DELAY,
    wordsDelay = 0,
  }: {
    /** When the growing part's box starts opening (default: {@link GROW_DELAY} after `at`). */
    growAt?: number;
    /**
     * How long after the box starts growing its words start coming in. A part
     * grown INSIDE a line (the title) waits until its box has mostly opened,
     * so it never shows clipped against the words after it.
     */
    wordsDelay?: number;
  } = {},
): { a: Key[]; p: Key[]; q: Key[]; done: number } {
  return {
    a: [
      [at + 0.02, 0],
      [at + 0.6, 1, "outCubic"],
    ],
    p: [
      [growAt - 0.1, 0],
      [growAt + 0.55, 1, "inOutCubic"],
    ],
    q: [
      [growAt + wordsDelay, 0],
      [growAt + wordsDelay + 0.6, 1, "outCubic"],
    ],
    done: growAt + wordsDelay + 0.6,
  };
}

/** From a card's first part starting in to its growing part starting to open. */
const GROW_DELAY = 0.8;

export interface TitleTimes {
  /** The session starts showing under the title (the card starts fading). */
  sessionAt: number;
  /** Film time `x` moved to the music's nearest beat (identity without a beat grid). */
  onBeat: (x: number) => number;
}

/**
 * The opening title, mirroring the end card: up from black onto the site's
 * background, "A personal OS", read alone a moment, then "self-evolving"
 * growing into its place in the phrase in the homepage's accent gradient
 * (its growth starting on a beat), held only while it is read; then — cut on
 * motion — the words blur out on a beat and the card fades into the session
 * while they are still leaving, so there is no dead hold between the title
 * and the app. Returns the scene and when it is gone.
 */
export function titleCard({ sessionAt, onBeat }: TitleTimes): {
  scene: Scene;
  end: number;
} {
  const at = 0.15;
  // "A personal OS" lands at ~0.75 s; "self-evolving" starts growing on the
  // beat nearest 0.95 s (its words in ~0.2 s later, done ~0.8 s after).
  const reveal = revealKeys(at, {
    growAt: onBeat(at + GROW_DELAY),
    wordsDelay: 0.2,
  });
  // The whole phrase is held ~0.35 s, then the words start leaving on a beat —
  // never after the session starts coming through.
  const outAt = Math.min(onBeat(reveal.done + 0.35), sessionAt - 0.1);
  const goneAt = outAt + 0.4;
  const end = sessionAt + 0.5;
  const leave = (keys: Key[]): Key[] => [
    ...keys,
    [outAt, 1],
    [goneAt, 0, "inCubic"],
  ];
  const a = leave(reveal.a);
  const q = leave(reveal.q);
  const { p } = reveal;
  return {
    end,
    scene: {
      layers: [],
      overlay: [
        shape(
          { kind: "rect", width: W, height: H, fill: SITE.bg },
          {
            end,
            opacity: [
              [sessionAt, 1],
              [end, 0, "inOutSine"],
            ],
          },
        ),
        html(
          growingLine({
            before: "A ",
            // The space after it stays out of the gradient (the homepage's
            // accent ends on its last letter).
            grown: `${accent("self-evolving")} `,
            after: "personal OS",
            size: TITLE_SIZE,
          }),
          W,
          H,
          { end: goneAt, vars: { a, p, q } },
        ),
        // Up from black, as the end card goes down to it.
        shape(
          { kind: "rect", width: W, height: H, fill: "#000" },
          {
            end: 0.5,
            opacity: [
              [0, 1],
              [0.5, 0, "outSine"],
            ],
          },
        ),
      ],
    },
  };
}

export interface OutroTimes {
  /** The end card starts (fading in over the desktop). */
  end: number;
  /** The film's last instant. */
  duration: number;
}

export function outro({ end, duration }: OutroTimes): Scene {
  const fadeAt = duration - 1.1;
  const { a, p, q, done } = revealKeys(end);
  const lineAt = done + 0.1;
  const sfx: SfxCue[] = [];
  return {
    layers: [],
    overlay: [
      // The site's background under the end card.
      shape(
        { kind: "rect", width: W, height: H, fill: SITE.bg },
        {
          start: end - 0.5,
          opacity: [
            [end - 0.5, 0],
            [end + 0.1, 1, "inOutSine"],
          ],
        },
      ),
      html(END_CARD, W, H, { start: end, vars: { a, p, q } }),
      html(
        `<div style="width:${W}px;height:40px;display:flex;align-items:center;justify-content:center;font:500 20px 'Inter Variable',Inter,sans-serif;letter-spacing:-0.005em;color:${SITE.muted}">Free and open source</div>`,
        W,
        40,
        {
          start: lineAt,
          x: 0,
          y: H / 2 + WORD_SIZE * 0.62,
          opacity: [
            [lineAt, 0],
            [lineAt + 0.6, 1, "outCubic"],
          ],
        },
      ),
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
