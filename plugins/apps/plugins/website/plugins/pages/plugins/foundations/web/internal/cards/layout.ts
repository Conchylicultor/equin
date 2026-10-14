import { defineCard } from "../kit/types";
import "./layout.css";

const ic = (d: string) =>
  `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="${d}"/></svg>`;
/** [id, glyph] */
const TOOLS = [
  ["add", "M6 2.5v7 M2.5 6h7"],
  ["share", "M6 7.5V2 M3.8 4.2L6 2l2.2 2.2 M2.5 7v3h7V7"],
  ["filter", "M2 2.5h8L7 6.3V10L5 9V6.3z"],
  ["down", "M6 2v6 M3.8 5.8L6 8l2.2-2.2 M2.5 10h7"],
] as const;
/** [id, glyph, label bar width] */
const SIDE = [
  ["home", "M2 6L6 2.5L10 6 M3.2 5v4.8h5.6V5", 70],
  [
    "inbox",
    "M2 6.5h2.5l.8 1.4h1.4l.8-1.4H10 M2 6.5L3.3 2.5h5.4L10 6.5V10H2z",
    58,
  ],
  [
    "star",
    "M6 1.8l1.3 2.7l2.9.4l-2.1 2l.5 2.9L6 8.4L3.4 9.8l.5-2.9l-2.1-2l2.9-.4z",
    80,
  ],
  [
    "gear",
    "M6 4.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6 M6 1.5v1.3 M6 9.2v1.3 M1.5 6h1.3 M9.2 6h1.3 M2.8 2.8l.9.9 M8.3 8.3l.9.9 M2.8 9.2l.9-.9 M8.3 3.7l.9-.9",
    64,
  ],
] as const;
// what state 4 adds: a toolbar button in the hidden one's place, and a sidebar item at the bottom
const NEW_TOOL = [
  "spark",
  "M6 1.5l1.1 3.4L10.5 6L7.1 7.1L6 10.5L4.9 7.1L1.5 6l3.4-1.1z",
] as const;
const NEW_SIDE = ["chart", "M2 10h8 M3.5 8V6 M6 8V3 M8.5 8V5", 54] as const;

/**
 * Custom UI, drawn without words: an app whose toolbar icons and sidebar items rearrange themselves, then gain new ones.
 * States: 0 as shipped · 1 the last toolbar icon moves to the front · 2 a sidebar item moves to the top ·
 * 3 a toolbar icon is hidden · 4 a new toolbar button and a new sidebar item are added. Every piece is drawn once; its slot (--p) and visibility are set by CSS per state,
 * and the piece being moved is lifted in the accent colour while it travels.
 */
export const layoutCard = defineCard({
  states: 5,
  autoplay: { seq: [0, 1, 2, 3, 4], every: [1800, 1800, 1800, 1800, 2800] },
  render: () => {
    const tools = TOOLS.map(
      ([id, d], p) =>
        `<span class="ly-t" data-t="${id}" style="--p:${p}">${ic(d)}</span>`,
    ).join("");
    const side =
      SIDE.map(
        ([id, d, w], p) =>
          `<span class="ly-s" data-t="${id}" style="--p:${p}">${ic(d)}<i style="width:${w}%"></i></span>`,
      ).join("") +
      `<span class="ly-s ly-new" data-t="${NEW_SIDE[0]}" style="--p:4">${ic(NEW_SIDE[1])}<i style="width:${NEW_SIDE[2]}%"></i></span>`;
    const added = `<span class="ly-t ly-new" data-t="${NEW_TOOL[0]}" style="--p:3">${ic(NEW_TOOL[1])}</span>`;
    return (
      `<span class="k-html"><span class="ly-app"><span class="ly-side">${side}</span><span class="ly-main"><span class="ly-bar">${tools}${added}</span>` +
      `<span class="ly-line big"></span><span class="ly-line" style="width:88%"></span><span class="ly-line" style="width:74%"></span><span class="ly-line" style="width:80%"></span></span></span></span>`
    );
  },
});
