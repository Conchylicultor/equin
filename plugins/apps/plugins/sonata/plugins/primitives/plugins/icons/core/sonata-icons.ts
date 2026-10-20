import { defineIconFamily } from "@plugins/ui/plugins/icons/core";

/**
 * Sonata's icon family, drawn from the song-view mockup
 * (`proto-1792113547-2qr6g7`): line glyphs in a 24-unit box at a 1.7 stroke
 * with round caps and joins; `play` alone is filled.
 *
 * `symbols` restyles the Material names Sonata's chrome writes, so in a scope
 * whose `iconFamily` is `sonata` (the Sonata theme) `symbol("close")` draws
 * `close` here — shared ui-kit chrome included; any other name falls back to
 * Lucide, as the theme drew before. The music glyphs Material has no name for
 * are named directly: `sonataIcons.icon("piano-roll")`.
 */
export const sonataIcons = defineIconFamily({
  id: "sonata",
  label: "Sonata",
  fallback: "lucide",
  stroke: 1.7,
  glyphs: {
    back: { body: '<path d="M15 5l-7 7 7 7"/>' },
    down: { body: '<path d="M7 10l5 5 5-5"/>' },
    grid: {
      body: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    },
    notation: {
      body: '<path d="M10 18V5l9-2v12"/><circle cx="7.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>',
    },
    "piano-roll": {
      body: '<path d="M6 4v7M10 4v12M14 4v5M18 4v10"/><path d="M3.5 20h17"/>',
    },
    sheet: {
      body: '<path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20z"/><path d="M9 11h7M9 14.5h7M9 18h4"/>',
    },
    play: {
      body: '<path d="M8 5.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5z"/>',
      paint: "fill",
    },
    pause: {
      body: '<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>',
    },
    loop: {
      body: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>',
    },
    swing: {
      body: '<path d="M8 17V5.5h9V15"/><circle cx="6" cy="17" r="2.2"/><circle cx="15" cy="15" r="2.2"/><path d="M8 9h9"/><path d="M3.5 21c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0"/>',
    },
    metronome: {
      body: '<path d="M9 3h6l4 17H5z"/><path d="M12 15l5-8"/><path d="M7.5 15h9"/>',
    },
    speed: {
      body: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1"/>',
    },
    volume: {
      body: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    },
    mute: {
      body: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    },
    transpose: {
      body: '<path d="M8 20V5M4.5 8.5L8 5l3.5 3.5"/><path d="M16 4v15M12.5 15.5L16 19l3.5-3.5"/>',
    },
    zoom: { body: '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>' },
    fullscreen: { body: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' },
    close: { body: '<path d="M6 6l12 12M18 6L6 18"/>' },
    progression: {
      body: '<rect x="2.5" y="8" width="5.5" height="8" rx="1.5"/><rect x="9.25" y="8" width="5.5" height="8" rx="1.5"/><rect x="16" y="8" width="5.5" height="8" rx="1.5"/>',
    },
    pick: {
      body: '<path d="M12 20.5c-3.2-3.2-7-7.6-7-11.6C5 5.9 8.2 4 12 4s7 1.9 7 4.9c0 4-3.8 8.4-7 11.6z"/>',
    },
    chord: {
      body: '<circle cx="9" cy="17.5" r="2.4"/><circle cx="9" cy="11.5" r="2.4"/><circle cx="9" cy="5.5" r="2.4"/><path d="M11.4 5.5V19M11.4 5.5h6"/>',
    },
    panel: {
      body: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
    },
    key: {
      body: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H20M17 12v3M20 12v2"/>',
    },
    effects: {
      body: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    },
    harmony: {
      body: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 3.5v4.5M12 16v4.5"/>',
    },
    sliders: {
      body: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    },
    wave: { body: '<path d="M4 12h2M8 8v8M12 5v14M16 8v8M20 11v2"/>' },
    video: {
      body: '<rect x="3" y="5.5" width="18" height="13" rx="3"/><path d="M10.5 9.5v5l4-2.5z"/>',
    },
    note: {
      body: '<path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>',
    },
    bars: {
      body: '<rect x="3.5" y="5" width="7.5" height="6" rx="1.5"/><rect x="13" y="5" width="7.5" height="6" rx="1.5"/><rect x="3.5" y="13" width="7.5" height="6" rx="1.5"/><rect x="13" y="13" width="7.5" height="6" rx="1.5"/>',
    },
    piano: {
      body: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 5v14M12 5v14M16 5v14"/><path d="M8 5v8M12 5v8" stroke-width="3.2"/>',
    },
    eye: {
      body: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    },
    "eye-off": {
      body: '<path d="M4 4l16 16"/><path d="M9.9 6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-2.8 3.6M6.3 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.5 0 2.8-.4 4-1"/>',
    },
    "check-circle": {
      body: '<circle cx="12" cy="12" r="9"/><path d="M8 12.2l2.7 2.7L16 9.5"/>',
    },
    check: { body: '<path d="M5 12.5l4.5 4.5L19 7.5"/>' },
    alert: { body: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>' },
    add: { body: '<path d="M12 5v14M5 12h14"/>' },
    // Not in the mockup: the plus sign's pair, for the − of a stepper.
    remove: { body: '<path d="M5 12h14"/>' },
  },
  symbols: {
    "arrow-back": "back",
    "keyboard-arrow-down": "down",
    "grid-view": "grid",
    description: "sheet",
    "play-arrow": "play",
    pause: "pause",
    repeat: "loop",
    speed: "speed",
    "volume-up": "volume",
    "volume-off": "mute",
    "swap-vert": "transpose",
    height: "zoom",
    fullscreen: "fullscreen",
    close: "close",
    tune: "sliders",
    "graphic-eq": "wave",
    "smart-display": "video",
    "music-note": "note",
    piano: "piano",
    visibility: "eye",
    "visibility-off": "eye-off",
    "check-circle": "check-circle",
    check: "check",
    warning: "alert",
    add: "add",
    remove: "remove",
  },
});

/** A glyph name of {@link sonataIcons}. */
export type SonataGlyph = keyof typeof sonataIcons.glyphs;
