import {
  defineIconFamily,
  type IconMotion,
} from "@plugins/ui/plugins/icons/core";

/*
 * Drawing grammar (the agent-icons prototype, `proto-1789643584-ldt6`, and
 * the glyphs drawn after it in the same hand for the chrome's other names):
 * 24×24 grid, 1.6 stroke, round caps and joins, no fills except dots. Live
 * area 3–21; corners r=2–3. A part that moves carries `data-motion`; a stagger
 * is `data-motion-delay`, and a part transforms about its own box centre
 * unless `data-motion-origin` pins one in grid units.
 */

/** A moving part's attributes: its motion, optional stagger (ms) and origin (grid units). */
function m(
  motion: IconMotion,
  delay?: number,
  origin?: readonly [number, number],
): string {
  let attrs = `data-motion="${motion}"`;
  if (delay !== undefined) attrs += ` data-motion-delay="${delay}"`;
  if (origin !== undefined)
    attrs += ` data-motion-origin="${origin[0]} ${origin[1]}"`;
  return attrs;
}

/** A filled dot — the one element that overrides the family's stroke paint. */
function dot(cx: number, cy: number, r = 1.05, motion = ""): string {
  return `<circle ${motion} cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
}

// Pieces shared by several glyphs.
const PAGE =
  '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>';
const BUBBLE =
  '<path d="M20 14.5a2 2 0 0 1-2 2H8.5L4 20V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>';
const ROUND_BUBBLE = '<path d="M7.6 19.6A8.5 8.5 0 1 0 4.4 16.4L3 21z"/>';
const QUESTION = `<g ${m("tilt")}><path d="M9.6 9.3a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.1-2.5 3.5"/>${dot(12, 16.4, 0.95)}</g>`;
const PENCIL =
  '<path d="M14.5 5.5l4 4M4.5 19.5l.9-4.1L15.6 5.2a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.6 18.6z"/>';
const RING = '<circle cx="12" cy="12" r="8.5"/>';
const SLASH = `<path ${m("draw")} d="M4 4l16 16"/>`;
const EYE =
  '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>';
const CLOUD =
  '<path d="M7 18.5a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6-1.5 4.5 4.5 0 0 1 0 9.5z"/>';
const LINK_A = "M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1";
const LINK_B = "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1";
/** The clockwise loop of refresh and automation: an arc closing on an arrowhead at its top right. */
const LOOP_CW =
  '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 4.5V9H16"/>';
const GEAR =
  '<path d="M10.3 5.8L10.7 3.5A8.6 8.6 0 0 1 13.3 3.5L13.7 5.8A6.4 6.4 0 0 1 15.2 6.5L17.1 5A8.6 8.6 0 0 1 19 6.9L17.5 8.8A6.4 6.4 0 0 1 18.2 10.3L20.5 10.7A8.6 8.6 0 0 1 20.5 13.3L18.2 13.7A6.4 6.4 0 0 1 17.5 15.2L19 17.1A8.6 8.6 0 0 1 17.1 19L15.2 17.5A6.4 6.4 0 0 1 13.7 18.2L13.3 20.5A8.6 8.6 0 0 1 10.7 20.5L10.3 18.2A6.4 6.4 0 0 1 8.8 17.5L6.9 19A8.6 8.6 0 0 1 5 17.1L6.5 15.2A6.4 6.4 0 0 1 5.8 13.7L3.5 13.3A8.6 8.6 0 0 1 3.5 10.7L5.8 10.3A6.4 6.4 0 0 1 6.5 8.8L5 6.9A8.6 8.6 0 0 1 6.9 5L8.8 6.5A6.4 6.4 0 0 1 10.3 5.8z"/><circle cx="12" cy="12" r="2.8"/>';

const glyphs = {
  /* ── direction ─────────────────────────────────────────────────────── */
  "chevron-down": { body: `<path ${m("nudge-down")} d="M7 10l5 5 5-5"/>` },
  "chevron-right": { body: `<path ${m("nudge-right")} d="M10 7l5 5-5 5"/>` },
  "arrow-up": {
    body: `<g ${m("nudge-up")}><path d="M12 19.5V5"/><path d="M6.5 10.5 12 5l5.5 5.5"/></g>`,
  },
  "arrow-down": {
    body: `<g ${m("nudge-down")}><path d="M12 4.5V19"/><path d="M6.5 13.5 12 19l5.5-5.5"/></g>`,
  },
  "arrow-up-down": {
    body:
      `<g ${m("nudge-up")}><path d="M8 19.5V5"/><path d="M4.5 8.5 8 5l3.5 3.5"/></g>` +
      `<g ${m("nudge-down")}><path d="M16 4.5V19"/><path d="M12.5 15.5 16 19l3.5-3.5"/></g>`,
  },
  "arrow-down-up": {
    body:
      `<g ${m("nudge-down")}><path d="M8 4.5V19"/><path d="M4.5 15.5 8 19l3.5-3.5"/></g>` +
      `<g ${m("nudge-up")}><path d="M16 19.5V5"/><path d="M12.5 8.5 16 5l3.5 3.5"/></g>`,
  },
  upload: {
    body:
      '<path d="M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>' +
      `<g ${m("nudge-up")}><path d="M12 15V4.5"/><path d="M7.5 9 12 4.5 16.5 9"/></g>`,
  },
  share: {
    body:
      '<path d="M9 9.5H7.5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H15"/>' +
      `<g ${m("nudge-up")}><path d="M12 14V3.5"/><path d="M8.5 7 12 3.5 15.5 7"/></g>`,
  },
  "undo-2": {
    body: `<g ${m("nudge-left")}><path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5 5 0 0 1 0 10h-3"/></g>`,
  },

  "chevron-up": { body: `<path ${m("nudge-up")} d="M7 14l5-5 5 5"/>` },
  "chevron-left": { body: `<path ${m("nudge-left")} d="M14 7l-5 5 5 5"/>` },
  "chevrons-up-down": {
    body: `<path ${m("nudge-up")} d="M7.5 9 12 4.5 16.5 9"/><path ${m("nudge-down")} d="M7.5 15l4.5 4.5 4.5-4.5"/>`,
  },
  "chevrons-down-up": {
    body: `<path ${m("nudge-down")} d="M7.5 4.5 12 9l4.5-4.5"/><path ${m("nudge-up")} d="M7.5 19.5 12 15l4.5 4.5"/>`,
  },
  "arrow-left": {
    body: `<g ${m("nudge-left")}><path d="M19.5 12H5"/><path d="M10.5 6.5 5 12l5.5 5.5"/></g>`,
  },
  "arrow-right": {
    body: `<g ${m("nudge-right")}><path d="M4.5 12H19"/><path d="M13.5 6.5 19 12l-5.5 5.5"/></g>`,
  },
  download: {
    body:
      '<path d="M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>' +
      `<g ${m("nudge-down")}><path d="M12 4.5V15"/><path d="M7.5 10.5 12 15l4.5-4.5"/></g>`,
  },
  "arrow-up-from-line": {
    body:
      '<path d="M6 20h12"/>' +
      `<g ${m("nudge-up")}><path d="M12 16.5V4.5"/><path d="M7 9.5l5-5 5 5"/></g>`,
  },
  "log-out": {
    body:
      '<path d="M9.5 4.5h-3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/>' +
      `<g ${m("nudge-right")}><path d="M10 12h9.5"/><path d="M15.5 8l4 4-4 4"/></g>`,
  },
  "rotate-cw": { body: `<g ${m("spin", undefined, [12, 12])}>${LOOP_CW}</g>` },
  "rotate-ccw": {
    body: `<g ${m("rewind", undefined, [12, 12])}><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4.5V9h4.5"/></g>`,
  },

  /* ── actions ───────────────────────────────────────────────────────── */
  check: { body: `<path ${m("draw")} d="M5 12.5l4.5 4.5L19 7.5"/>` },
  plus: { body: `<g ${m("turn")}><path d="M12 5v14M5 12h14"/></g>` },
  x: { body: `<g ${m("turn")}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></g>` },
  play: {
    body: `<path ${m("nudge-right")} d="M8 6.2v11.6a1.2 1.2 0 0 0 1.8 1l9.3-5.8a1.2 1.2 0 0 0 0-2L9.8 5.2A1.2 1.2 0 0 0 8 6.2z"/>`,
  },
  square: {
    body: `<rect ${m("pop")} x="6" y="6" width="12" height="12" rx="2.5"/>`,
  },
  search: {
    body: `<g ${m("scan")}><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></g>`,
  },
  ellipsis: {
    body:
      dot(5.5, 12, 1.3, m("bob")) +
      dot(12, 12, 1.3, m("bob", 70)) +
      dot(18.5, 12, 1.3, m("bob", 140)),
  },
  copy: {
    body:
      '<path d="M15 8.5V6.5A2 2 0 0 0 13 4.5H6.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2h2"/>' +
      `<rect ${m("slide")} x="9" y="9" width="10.5" height="10.5" rx="2"/>`,
  },
  split: {
    body:
      '<path d="M12 20.5V13"/>' +
      `<path ${m("splay-l", undefined, [12, 13])} d="M12 13 7 8V3.5"/>` +
      `<path ${m("splay-r", undefined, [12, 13])} d="M12 13l5-5V3.5"/>`,
  },
  link: {
    body:
      `<path ${m("link-a")} d="${LINK_A}"/>` +
      `<path ${m("link-b")} d="${LINK_B}"/>`,
  },
  pencil: { body: `<g ${m("scribble", undefined, [5, 19])}>${PENCIL}</g>` },
  "pen-line": {
    body:
      `<path ${m("draw")} d="M12.5 20h7"/>` +
      `<g ${m("scribble", undefined, [5, 19])}><path d="M4.5 19.5l.9-4.1L14.6 6.2a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.6 18.6z"/></g>`,
  },
  mic: {
    body:
      `<rect ${m("bob")} x="9" y="3.5" width="6" height="11" rx="3"/>` +
      '<path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  },

  minus: { body: `<path ${m("squeeze")} d="M5 12h14"/>` },
  send: {
    body: `<g ${m("drift")}><path d="M4.5 4.8 20 12 4.5 19.2 7 12z"/><path d="M7 12h6"/></g>`,
  },
  trash: {
    body:
      `<g ${m("open-l", undefined, [4, 7])}><path d="M4 7h16"/><path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2"/></g>` +
      '<path d="M6 7l.9 11.6a2 2 0 0 0 2 1.9h6.2a2 2 0 0 0 2-1.9L18 7"/><path d="M10 11v5.5M14 11v5.5"/>',
  },
  // Eight teeth, so the quarter turn ends where it started.
  settings: { body: `<g ${m("turn")}>${GEAR}</g>` },
  "sliders-horizontal": {
    body:
      '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h7M15 17h5"/>' +
      `<circle ${m("nudge-left")} cx="15" cy="7" r="2"/>` +
      `<circle ${m("nudge-right", 70)} cx="9" cy="12" r="2"/>` +
      `<circle ${m("nudge-left", 140)} cx="13" cy="17" r="2"/>`,
  },
  pin: {
    body: `<g ${m("nudge-down")}><path d="M9 3.5h6"/><path d="M10 3.5v5.5l-3 3v2h10v-2l-3-3V3.5"/><path d="M12 14v6.5"/></g>`,
    // Pinned: the head filled — drawn, since the head is an open path the
    // derived form would not fill.
    active: `<g ${m("nudge-down")}><path d="M9 3.5h6"/><path fill="currentColor" d="M10 3.5v5.5l-3 3v2h10v-2l-3-3V3.5z"/><path d="M12 14v6.5"/></g>`,
  },
  "bookmark-plus": {
    body:
      '<path d="M6.5 20.5V5.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15L12 17z"/>' +
      `<g ${m("turn")}><path d="M12 7.5v5M9.5 10h5"/></g>`,
  },
  "grip-vertical": {
    body:
      dot(9, 6, 1.3, m("bob")) +
      dot(15, 6, 1.3, m("bob")) +
      dot(9, 12, 1.3, m("bob", 70)) +
      dot(15, 12, 1.3, m("bob", 70)) +
      dot(9, 18, 1.3, m("bob", 140)) +
      dot(15, 18, 1.3, m("bob", 140)),
  },
  "mouse-pointer-click": {
    body:
      `<path ${m("slide")} d="M9 9l10.5 4-4.5 1.8-1.8 4.7z"/>` +
      `<g ${m("light")}><path d="M9 3.5v2M3.5 9h2M5.1 5.1l1.4 1.4M12.9 5.1l-1.4 1.4M5.1 12.9l1.4-1.4"/></g>`,
  },
  wrench: {
    body: `<path ${m("tilt", undefined, [12, 12])} d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.3-3.3a5.5 5.5 0 0 1-7.4 7.4l-6.4 6.4a2 2 0 0 1-2.9-2.9l6.4-6.4a5.5 5.5 0 0 1 7.4-7.4z"/>`,
  },
  zap: {
    body: `<path ${m("light")} d="M13.5 3 5 13.5h6.5L10.5 21 19 10.5h-6.5z"/>`,
  },

  /* ── text & code ───────────────────────────────────────────────────── */
  braces: {
    body:
      `<path ${m("nudge-left")} d="M9 4.5c-1.7 0-2.5.8-2.5 2.3v2.4c0 1.3-.7 2.3-2 2.8 1.3.5 2 1.5 2 2.8v2.4c0 1.5.8 2.3 2.5 2.3"/>` +
      `<path ${m("nudge-right")} d="M15 4.5c1.7 0 2.5.8 2.5 2.3v2.4c0 1.3.7 2.3 2 2.8-1.3.5-2 1.5-2 2.8v2.4c0 1.5-.8 2.3-2.5 2.3"/>`,
  },
  "code-xml": {
    body:
      `<path ${m("nudge-left")} d="M8 7.5 3.5 12 8 16.5"/>` +
      `<path ${m("nudge-right")} d="M16 7.5l4.5 4.5-4.5 4.5"/>` +
      `<path ${m("tilt")} d="M13.5 5.5l-3 13"/>`,
  },
  "square-terminal": {
    body:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/>' +
      `<path ${m("nudge-right")} d="M7.5 9.5 10 12l-2.5 2.5"/>` +
      `<path ${m("blink")} d="M12.5 15h4"/>`,
  },
  "file-text": {
    body:
      PAGE +
      `<path ${m("draw")} d="M9 13h6"/>` +
      `<path ${m("draw", 110)} d="M9 16.5h4"/>`,
  },
  "file-diff": {
    body:
      PAGE +
      `<g ${m("turn")}><path d="M12 10v4.5M9.75 12.25h4.5"/></g>` +
      `<path ${m("squeeze", 80)} d="M9.75 17h4.5"/>`,
  },
  "sticky-note": {
    body:
      `<g ${m("tilt", undefined, [12, 20])}><path d="M20 13.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7.5z"/>` +
      '<path d="M13.5 20v-4.5a2 2 0 0 1 2-2H20"/></g>',
  },
  "book-open": {
    body:
      `<path ${m("open-l", undefined, [12, 20])} d="M12 7c-1.8-1.4-4.3-2.2-8.5-2.2v13.8c4.2 0 6.7.8 8.5 2.2"/>` +
      `<path ${m("open-r", undefined, [12, 20])} d="M12 7c1.8-1.4 4.3-2.2 8.5-2.2v13.8c-4.2 0-6.7.8-8.5 2.2"/>` +
      '<path d="M12 7v13.5"/>',
  },

  megaphone: {
    body:
      '<path d="M4.5 9.5a1 1 0 0 1 1-1H8l6.5-4v15L8 15.5H5.5a1 1 0 0 1-1-1z"/><path d="M8 15.5l1 4"/>' +
      `<path ${m("light")} d="M18 7.5l2-1.5"/>` +
      `<path ${m("light", 80)} d="M18.5 12h2"/>` +
      `<path ${m("light", 160)} d="M18 16.5l2 1.5"/>`,
  },
  bell: {
    body:
      `<g ${m("shake", undefined, [12, 3.5])}><path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 5.5 2.5 7.5 2.5 7.5H4s2.5-2 2.5-7.5z"/>` +
      '<path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/></g>',
  },

  /* ── conversation ──────────────────────────────────────────────────── */
  "message-square": {
    body:
      BUBBLE +
      dot(8.5, 10.25, 0.95, m("type")) +
      dot(12, 10.25, 0.95, m("type", 90)) +
      dot(15.5, 10.25, 0.95, m("type", 180)),
  },
  "messages-square": {
    body:
      '<path d="M15 9.5a2 2 0 0 1-2 2H7.5L4 14.5V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z"/>' +
      `<path ${m("bob", 60)} d="M18 8.5h.5a1.5 1.5 0 0 1 1.5 1.5v11l-3.5-3H11a2 2 0 0 1-2-2v-1"/>`,
  },
  "message-square-plus": {
    body: BUBBLE + `<g ${m("turn")}><path d="M12 7.5v5.5M9.25 10.25h5.5"/></g>`,
  },
  "message-circle-question": { body: ROUND_BUBBLE + QUESTION },
  "circle-help": { body: '<circle cx="12" cy="12" r="8.5"/>' + QUESTION },

  /* ── status ────────────────────────────────────────────────────────── */
  circle: { body: `<circle ${m("pop")} cx="12" cy="12" r="8.5"/>` },
  "circle-check": {
    body: RING + `<path ${m("draw")} d="M8 12.3l2.8 2.8 5.2-5.4"/>`,
  },
  "circle-x": {
    body: RING + `<g ${m("turn")}><path d="M9 9l6 6M15 9l-6 6"/></g>`,
  },
  "circle-alert": {
    body: `<g ${m("shake")}>${RING}<path d="M12 7.5v5"/>${dot(12, 16.2, 0.95)}</g>`,
  },
  "triangle-alert": {
    body:
      '<path d="M10.3 5.1a2 2 0 0 1 3.4 0l6.9 11.9a2 2 0 0 1-1.7 3H5.1a2 2 0 0 1-1.7-3z"/>' +
      `<g ${m("blink")}><path d="M12 9.5v4"/>${dot(12, 16.8, 0.95)}</g>`,
  },
  info: {
    body: RING + `<g ${m("bob")}>${dot(12, 8, 0.95)}<path d="M12 11v5.5"/></g>`,
  },
  pause: {
    body: `<g ${m("squeeze")}><rect x="6.5" y="5" width="3.5" height="14" rx="1.2"/><rect x="14" y="5" width="3.5" height="14" rx="1.2"/></g>`,
  },
  "circle-pause": {
    body: RING + `<g ${m("squeeze")}><path d="M10 9v6M14 9v6"/></g>`,
  },
  "circle-stop": {
    body:
      RING + `<rect ${m("pop")} x="9" y="9" width="6" height="6" rx="1.2"/>`,
  },
  clock: {
    body: RING + `<path ${m("spin", undefined, [12, 12])} d="M12 7.5V12l3 2"/>`,
  },
  // A ring with a wedge of progress turning inside it (Material's timelapse).
  "circle-progress": {
    body:
      RING +
      `<path ${m("spin", undefined, [12, 12])} d="M12 12V6.5a5.5 5.5 0 0 1 3.9 9.4z"/>`,
  },
  // Material's auto-mode: the refresh loop with a sparkle at its centre.
  automation: {
    body:
      `<g ${m("spin", undefined, [12, 12])}>${LOOP_CW}</g>` +
      `<path ${m("spark", 160)} d="M12 8c.4 2.1 1.9 3.6 4 4-2.1.4-3.6 1.9-4 4-.4-2.1-1.9-3.6-4-4 2.1-.4 3.6-1.9 4-4z"/>`,
  },
  "eye-off": { body: `<g ${m("blink-y")}>${EYE}</g>` + SLASH },
  "cloud-off": { body: `<g ${m("drift")}>${CLOUD}</g>` + SLASH },
  unlink: {
    body:
      `<path ${m("link-a")} d="${LINK_A}"/><path ${m("link-b")} d="${LINK_B}"/>` +
      SLASH,
  },
  shield: {
    body: `<path ${m("pop")} d="M12 3.5 19 6v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z"/>`,
  },

  /* ── lists & layout ────────────────────────────────────────────────── */
  "list-checks": {
    body:
      `<path ${m("draw")} d="M4 6.5l1.5 1.5 3-3"/>` +
      `<path ${m("draw", 130)} d="M4 16.5l1.5 1.5 3-3"/>` +
      '<path d="M12 6.5h8M12 12h8M12 17.5h8"/>',
  },
  "list-ordered": {
    body:
      '<path d="M4.5 5.2 6 4.5v5"/><path d="M4.3 14.7a1.5 1.5 0 0 1 2.9.5c0 1.2-2.9 2.3-2.9 3.3h3"/>' +
      `<path ${m("nudge-right")} d="M11 7h9"/><path ${m("nudge-right", 70)} d="M11 12h9"/><path ${m("nudge-right", 140)} d="M11 17h9"/>`,
  },
  "list-filter": {
    body: `<path ${m("squeeze")} d="M4 6.5h16"/><path ${m("squeeze", 70)} d="M7 12h10"/><path ${m("squeeze", 140)} d="M10 17.5h4"/>`,
  },
  "layout-list": {
    body:
      '<rect x="4" y="4.5" width="5.5" height="5.5" rx="1.4"/><rect x="4" y="14" width="5.5" height="5.5" rx="1.4"/>' +
      `<path ${m("nudge-right")} d="M13 6h7"/><path ${m("nudge-right", 50)} d="M13 8.5h4.5"/>` +
      `<path ${m("nudge-right", 100)} d="M13 15.5h7"/><path ${m("nudge-right", 150)} d="M13 18h4.5"/>`,
  },
  "rows-3": {
    body:
      '<rect x="3.5" y="4" width="17" height="16" rx="3"/>' +
      `<path ${m("nudge-down")} d="M3.5 9.5h17"/><path ${m("nudge-up")} d="M3.5 14.5h17"/>`,
  },
  layers: {
    body:
      `<path ${m("nudge-up")} d="M12 3.5 3.5 8 12 12.5 20.5 8z"/>` +
      '<path d="M3.5 12 12 16.5 20.5 12"/>' +
      `<path ${m("nudge-down")} d="M3.5 16 12 20.5 20.5 16"/>`,
  },
  boxes: {
    body:
      '<rect x="3.5" y="12.5" width="8" height="8" rx="1.8"/><rect x="12.5" y="12.5" width="8" height="8" rx="1.8"/>' +
      `<rect ${m("hop")} x="8" y="3.5" width="8" height="8" rx="1.8"/>`,
  },
  "panel-left": {
    body: `<rect x="3.5" y="4" width="17" height="16" rx="3"/><path ${m("nudge-right")} d="M9.5 4v16"/>`,
  },
  "layout-panel-left": {
    body:
      `<rect ${m("pop")} x="3.5" y="4" width="7.5" height="16" rx="2"/>` +
      `<rect ${m("pop", 70)} x="14" y="4" width="6.5" height="6.5" rx="2"/>` +
      `<rect ${m("pop", 140)} x="14" y="13.5" width="6.5" height="6.5" rx="2"/>`,
  },
  "chart-no-axes-column": {
    body: `<path ${m("grow")} d="M6 20v-6"/><path ${m("grow", 70)} d="M12 20V5"/><path ${m("grow", 140)} d="M18 20v-10"/>`,
  },
  activity: { body: `<path ${m("draw")} d="M3 12h4l2.5-6.5 5 13L17 12h4"/>` },
  eye: {
    body: `<g ${m("blink-y")}>${EYE}</g>`,
  },

  list: {
    body:
      dot(5, 7, 1.05) +
      dot(5, 12, 1.05) +
      dot(5, 17, 1.05) +
      `<path ${m("nudge-right")} d="M9 7h11"/><path ${m("nudge-right", 70)} d="M9 12h11"/><path ${m("nudge-right", 140)} d="M9 17h11"/>`,
  },
  // Left-aligned bars shortening downwards; each shrinks toward its start.
  sort: {
    body:
      `<path ${m("squeeze", undefined, [4, 7])} d="M4 7h16"/>` +
      `<path ${m("squeeze", 70, [4, 12])} d="M4 12h11"/>` +
      `<path ${m("squeeze", 140, [4, 17])} d="M4 17h6"/>`,
  },
  table: {
    body:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/>' +
      `<path ${m("draw")} d="M3.5 9.5h17"/><path ${m("draw", 90)} d="M3.5 14.5h17"/><path ${m("draw", 180)} d="M9.5 9.5v10"/>`,
  },
  "layout-grid": {
    body:
      `<rect ${m("pop")} x="4" y="4" width="7" height="7" rx="1.8"/>` +
      `<rect ${m("pop", 70)} x="13" y="4" width="7" height="7" rx="1.8"/>` +
      `<rect ${m("pop", 140)} x="4" y="13" width="7" height="7" rx="1.8"/>` +
      `<rect ${m("pop", 210)} x="13" y="13" width="7" height="7" rx="1.8"/>`,
  },
  "layout-dashboard": {
    body:
      `<rect ${m("pop")} x="3.5" y="3.5" width="7" height="9.5" rx="1.8"/>` +
      `<rect ${m("pop", 70)} x="13.5" y="3.5" width="7" height="4.5" rx="1.8"/>` +
      `<rect ${m("pop", 140)} x="13.5" y="11" width="7" height="9.5" rx="1.8"/>` +
      `<rect ${m("pop", 210)} x="3.5" y="16" width="7" height="4.5" rx="1.8"/>`,
  },
  // A hierarchy: a root and the two children it branches to (Material's account-tree).
  workflow: {
    body:
      '<rect x="3.5" y="3.5" width="6.5" height="5" rx="1.5"/><path d="M6.75 8.5v7.5a2 2 0 0 0 2 2h5.25M6.75 12H14"/>' +
      `<rect ${m("pop")} x="14" y="9.75" width="6.5" height="4.5" rx="1.5"/>` +
      `<rect ${m("pop", 90)} x="14" y="15.75" width="6.5" height="4.5" rx="1.5"/>`,
  },
  calendar: {
    body:
      '<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10h16"/>' +
      `<g ${m("bob")}><path d="M8.5 3.5v4M15.5 3.5v4"/></g>` +
      dot(15.5, 15.5, 1.2, m("pop", 90)),
  },

  /* ── places & things ───────────────────────────────────────────────── */
  folder: {
    body:
      '<path d="M3.5 17.5v-11A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>' +
      `<path ${m("nudge-down")} d="M3.5 10.5h17"/>`,
  },
  house: {
    body:
      `<path ${m("hop-small")} d="M3 11 12 3.5 21 11"/>` +
      '<path d="M5.5 9.5v9A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-9"/><path d="M10 20v-5h4v5"/>',
  },
  cloud: {
    body: `<g ${m("drift")}>${CLOUD}</g>`,
  },
  puzzle: {
    body: `<path ${m("tilt")} d="M5 8h4.5a2.2 2.2 0 1 1 3 0H17v4.5a2.2 2.2 0 1 1 0 3V20H5z"/>`,
  },
  plug: {
    body:
      `<g ${m("nudge-up")}><path d="M9 3.5v4M15 3.5v4"/><path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z"/></g>` +
      '<path d="M12 16v4.5"/>',
  },
  hourglass: {
    body:
      `<g ${m("flip")}><path d="M6.5 3.5h11M6.5 20.5h11"/>` +
      '<path d="M8 3.5c0 4 4 5.3 4 8.5s-4 4.5-4 8.5M16 3.5c0 4-4 5.3-4 8.5s4 4.5 4 8.5"/></g>',
  },
  history: {
    body:
      '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4.5V9h4.5"/>' +
      `<path ${m("rewind", undefined, [12, 12])} d="M12 7.5V12l3 2"/>`,
  },
  "flask-conical": {
    body:
      '<path d="M9.5 3.5v6L4.6 18a1.6 1.6 0 0 0 1.4 2.5h12a1.6 1.6 0 0 0 1.4-2.5l-4.9-8.5v-6M8 3.5h8"/>' +
      '<path d="M7 15h10"/>' +
      dot(10.5, 17.6, 0.85, m("bubble")) +
      dot(13.6, 17.2, 0.85, m("bubble", 160)),
  },
  // Drawn upright and turned 45° by a transform ATTRIBUTE on a still group:
  // the motion stylesheet sets a transform origin only on `[data-motion]`
  // parts, so the group keeps SVG's own (view-box, 0 0) and rotates about
  // 12 12 as written. The flame flickers along the rocket's own axis, which
  // is why the rotation is not baked into the coordinates.
  rocket: {
    body:
      `<g ${m("launch")}><g transform="rotate(45 12 12)">` +
      '<path d="M12 2.5c2.5 2 3.5 5 3.5 8.5v5h-7v-5c0-3.5 1-6.5 3.5-8.5z"/><circle cx="12" cy="9.5" r="1.5"/>' +
      '<path d="M8.5 13 6 15.5V18h2.5M15.5 13l2.5 2.5V18h-2.5"/>' +
      `<path ${m("flicker", undefined, [12, 18.5])} d="M10.5 18.5c0 1.5.5 2.5 1.5 3.5 1-1 1.5-2 1.5-3.5"/>` +
      "</g></g>",
  },
  factory: {
    body:
      '<path d="M3.5 20.5V11l5 3v-3l5 3V4.5H19v16z"/>' +
      `<path ${m("light")} d="M7 17.5h1"/><path ${m("light", 90)} d="M11 17.5h1"/><path ${m("light", 180)} d="M15.5 17.5h1"/>`,
  },

  map: {
    body: `<g ${m("squeeze")}><path d="M3.5 6.5 9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5-5.5 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></g>`,
  },
  user: {
    body: `<circle ${m("bob")} cx="12" cy="8" r="3.75"/><path d="M5 20a7 7 0 0 1 14 0"/>`,
  },

  /* ── agents & status ───────────────────────────────────────────────── */
  bot: {
    body:
      '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V5.2M2.5 13v2.5M21.5 13v2.5"/>' +
      dot(12, 4.3, 1.1, m("pop")) +
      `<g ${m("blink-y")}><path d="M9 12.75v1.5M15 12.75v1.5"/></g>`,
  },
  bug: {
    body:
      `<g ${m("shake")}><path d="M8 11a4 4 0 0 1 8 0v4.5a4 4 0 0 1-8 0z"/><path d="M9.5 7.5a2.5 2.5 0 0 1 5 0"/>` +
      '<path d="M12 11v8.5M8 12.5H4.5M16 12.5h3.5M8 16.5l-3 1.5M16 16.5l3 1.5M8.5 9 5.5 7.5M15.5 9l3-1.5"/></g>',
  },
  star: {
    body: `<path ${m("twinkle", undefined, [12, 12.4])} d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>`,
  },
  sparkles: {
    body:
      `<path ${m("spark")} d="M10 3.5c.6 3.4 2.6 5.4 6 6-3.4.6-5.4 2.6-6 6-.6-3.4-2.6-5.4-6-6 3.4-.6 5.4-2.6 6-6z"/>` +
      `<path ${m("pop", 120)} d="M17.5 14c.3 1.6 1.4 2.7 3 3-1.6.3-2.7 1.4-3 3-.3-1.6-1.4-2.7-3-3 1.6-.3 2.7-1.4 3-3z"/>`,
  },
  shapes: {
    body:
      `<path ${m("tilt")} d="M8.1 4.3a1 1 0 0 1 1.8 0l3.3 5.7a1 1 0 0 1-.9 1.5H5.7a1 1 0 0 1-.9-1.5z"/>` +
      `<circle ${m("bob", 70)} cx="17" cy="7.5" r="3.5"/>` +
      `<rect ${m("turn", 140)} x="8.5" y="13.5" width="7" height="7" rx="1.5"/>`,
  },

  /* ── git ───────────────────────────────────────────────────────────── */
  "git-branch": {
    body:
      `<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle ${m("pop")} cx="17.5" cy="6.5" r="2"/>` +
      `<path d="M6.5 7.5v9"/><path ${m("draw")} d="M17.5 8.5c0 4.5-4 6-11 8"/>`,
  },
  "git-commit-horizontal": {
    body: `<circle ${m("pop")} cx="12" cy="12" r="3.2"/><path ${m("nudge-left")} d="M3 12h5.8"/><path ${m("nudge-right")} d="M15.2 12H21"/>`,
  },
};

/** A glyph of the agent family (the prototype's Lucide-style names). */
export type AgentGlyph = keyof typeof glyphs;

/**
 * The agent manager's icon family, drawn from the agent-icons prototype
 * (`proto-1789643584-ldt6`): line glyphs in a 24-unit box at a 1.6 stroke,
 * each with a small one-shot motion played on hover inside a motion region
 * (the app-shell sidebar; `IconMotionRegion`, icons web).
 *
 * `symbols` restyles the Material names the agent manager's chrome draws
 * (its own plugins and the shared conversations / tasks / stats / shell /
 * primitives chrome it renders), so in a scope whose `iconFamily` is `agent`
 * (the Mist theme) `symbol("checklist")` draws `list-checks` here. Any other
 * name falls back to Lucide — listed as a fallback on Debug → Icons. Glyphs no
 * Material name maps to yet (`factory`, `pen-line`, …) stay reachable as
 * `agentIcons.icon("…")`.
 */
export const agentIcons = defineIconFamily<AgentGlyph>({
  id: "agent",
  label: "Agent",
  coverage: "fallback",
  fallback: "lucide",
  stroke: 1.6,
  glyphs,
  symbols: {
    // direction
    "expand-more": "chevron-down",
    "keyboard-arrow-down": "chevron-down",
    "chevron-right": "chevron-right",
    "keyboard-arrow-right": "chevron-right",
    "arrow-upward": "arrow-up",
    north: "arrow-up",
    "arrow-downward": "arrow-down",
    south: "arrow-down",
    "swap-vert": "arrow-up-down",
    "keyboard-arrow-up": "chevron-up",
    "expand-less": "chevron-up",
    "chevron-left": "chevron-left",
    "keyboard-arrow-left": "chevron-left",
    "unfold-more": "chevrons-up-down",
    "unfold-less": "chevrons-down-up",
    "arrow-back": "arrow-left",
    west: "arrow-left",
    "arrow-forward": "arrow-right",
    east: "arrow-right",
    download: "download",
    upgrade: "arrow-up-from-line",
    logout: "log-out",
    "exit-to-app": "log-out",
    refresh: "rotate-cw",
    replay: "rotate-ccw",
    "restart-alt": "rotate-ccw",
    upload: "upload",
    publish: "upload",
    share: "share",
    undo: "undo-2",
    // actions
    check: "check",
    add: "plus",
    close: "x",
    "play-arrow": "play",
    stop: "square",
    search: "search",
    "more-horiz": "ellipsis",
    "content-copy": "copy",
    "call-split": "split",
    "alt-route": "split",
    "fork-right": "split",
    link: "link",
    "add-link": "link",
    edit: "pencil",
    mic: "mic",
    "keyboard-voice": "mic",
    remove: "minus",
    send: "send",
    delete: "trash",
    "delete-forever": "trash",
    settings: "settings",
    tune: "sliders-horizontal",
    keep: "pin",
    "push-pin": "pin",
    "bookmark-add": "bookmark-plus",
    "drag-indicator": "grip-vertical",
    "ads-click": "mouse-pointer-click",
    build: "wrench",
    bolt: "zap",
    // text & code
    "data-object": "braces",
    api: "braces",
    code: "code-xml",
    terminal: "square-terminal",
    description: "file-text",
    article: "file-text",
    "text-snippet": "file-text",
    difference: "file-diff",
    "sticky-note-2": "sticky-note",
    "menu-book": "book-open",
    // conversation
    "chat-bubble": "message-square",
    comment: "message-square",
    forum: "messages-square",
    "add-comment": "message-square-plus",
    help: "circle-help",
    campaign: "megaphone",
    notifications: "bell",
    // status
    "radio-button-unchecked": "circle",
    "check-circle": "circle-check",
    "task-alt": "circle-check",
    cancel: "circle-x",
    error: "circle-alert",
    warning: "triangle-alert",
    info: "info",
    pause: "pause",
    "pause-circle": "circle-pause",
    "stop-circle": "circle-stop",
    schedule: "clock",
    timelapse: "circle-progress",
    "auto-mode": "automation",
    "visibility-off": "eye-off",
    "cloud-off": "cloud-off",
    "link-off": "unlink",
    shield: "shield",
    // lists & layout
    checklist: "list-checks",
    "format-list-numbered": "list-ordered",
    "filter-list": "list-filter",
    "view-list": "layout-list",
    "table-rows": "rows-3",
    layers: "layers",
    "left-panel-open": "panel-left",
    "left-panel-close": "panel-left",
    "view-quilt": "layout-panel-left",
    insights: "chart-no-axes-column",
    "bar-chart": "chart-no-axes-column",
    monitoring: "activity",
    visibility: "eye",
    list: "list",
    sort: "sort",
    table: "table",
    "grid-view": "layout-grid",
    dashboard: "layout-dashboard",
    "account-tree": "workflow",
    event: "calendar",
    "calendar-today": "calendar",
    // places & things
    folder: "folder",
    "folder-open": "folder",
    home: "house",
    cloud: "cloud",
    extension: "puzzle",
    "hourglass-empty": "hourglass",
    hourglass: "hourglass",
    history: "history",
    science: "flask-conical",
    "rocket-launch": "rocket",
    rocket: "rocket",
    factory: "factory",
    map: "map",
    person: "user",
    // agents & status
    "precision-manufacturing": "bot",
    "smart-toy": "bot",
    "bug-report": "bug",
    star: "star",
    "auto-awesome": "sparkles",
    category: "shapes",
    // git
    commit: "git-commit-horizontal",
  },
});
