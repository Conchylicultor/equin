import { defineIconFamily } from "@plugins/ui/plugins/icons/core";

/**
 * The Prototypes app's icon family, drawn from the canvas-viewer mockup
 * (`proto-1792527153-l4fzh8`): line glyphs in a 24-unit box at a 1.6 stroke
 * with round caps and joins. Every body is the mockup's `<symbol>` verbatim
 * (its id noted where the glyph is named differently here).
 *
 * `symbols` restyles the Material names the app writes — and the ones the
 * shared chrome it sits in writes (the launcher's face is the app's own icon,
 * `dashboard-customize`; the pane's Back is `arrow-back`; ui-kit's close and
 * select chevron) — so in a scope whose `iconFamily` is `prototypes` (the
 * Prototypes theme) `symbol("close")` draws `x` here. A name it does not map
 * falls back to Lucide. Glyphs Material has no name for are named directly:
 * `prototypesIcons.icon("compare")`.
 */
export const prototypesIcons = defineIconFamily({
  id: "prototypes",
  label: "Prototypes",
  fallback: "lucide",
  stroke: 1.6,
  glyphs: {
    // All apps: three tiles and a plus — the launcher's face.
    grid: {
      body: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
    },
    back: { body: '<path d="M19 12H5M11 18l-6-6 6-6"/>' },
    copy: {
      body: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    },
    pin: { body: '<path d="M9 4h6M10 4v6l-3 4h10l-3-4V4M12 14v6"/>' },
    done: {
      body: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>',
    },
    // Mock `cl` / `cr` / `cd`.
    "chevron-left": { body: '<path d="M15 18l-6-6 6-6"/>' },
    "chevron-right": { body: '<path d="M9 18l6-6-6-6"/>' },
    "chevron-down": { body: '<path d="M7 10l5 5 5-5"/>' },
    plus: { body: '<path d="M12 6v12M6 12h12"/>' },
    minus: { body: '<path d="M6 12h12"/>' },
    // The real app: a window with a sidebar (the source frame's "Real app" tag).
    app: {
      body: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M8 4v16"/>',
    },
    // Close others — keep only this frame.
    only: {
      body: '<rect x="8" y="6" width="8" height="12" rx="1.5"/><path d="M4 8v8M20 8v8"/>',
    },
    // Compare with the real app: a box half filled.
    compare: {
      body: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M12 3v18"/><path d="M12 5h5.5A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5H12z" fill="currentColor" stroke="none"/>',
    },
    // Mock `x`.
    close: { body: '<path d="M7 7l10 10M17 7L7 17"/>' },
    // Mock `ext`: open in a new tab.
    external: {
      body: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    },
    // Mock `dup`: a second frame.
    duplicate: {
      body: '<rect x="4" y="4" width="11" height="11" rx="2"/><path d="M9 20h9a2 2 0 0 0 2-2V9"/>',
    },
    // Mock `present`: full screen.
    present: { body: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' },
    sliders: {
      body: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    },
    // Mock `cols`: one frame per value.
    columns: {
      body: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14"/>',
    },
    filter: { body: '<path d="M4 6h16M7 12h10M10 18h4"/>' },
    // The size presets (the dock and the Size menu).
    window: {
      body: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M6.5 6.5h.01M9 6.5h.01"/>',
    },
    phone: {
      body: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
    },
    tablet: {
      body: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M11 18h2"/>',
    },
    laptop: {
      body: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
    },
    // Mock `desk`.
    desktop: {
      body: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
    },
    wide: {
      body: '<rect x="2" y="6" width="20" height="10" rx="2"/><path d="M9 20h6M12 16v4"/>',
    },
    // Mock `resp`: fills the canvas.
    responsive: { body: '<path d="M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3"/>' },
    // Whole page.
    page: { body: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>' },
    check: { body: '<path d="M5 12.5l4.5 4.5L19 7.5"/>' },
    target: {
      body: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>',
    },
    link: {
      body: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    },
    branch: {
      body: '<circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-11 6"/>',
    },
    doc: {
      body: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6M9 13h6"/>',
    },
    // Make this version the latest.
    up: { body: '<path d="M12 19V5M6 11l6-6 6 6"/>' },
  },
  symbols: {
    // Shared chrome: the launcher's face (the app's own icon, and the
    // launcher's "All apps"), the pane's Back, ui-kit's close and chevrons.
    "dashboard-customize": "grid",
    apps: "grid",
    "arrow-back": "back",
    close: "close",
    "keyboard-arrow-down": "chevron-down",
    "expand-more": "chevron-down",
    "chevron-left": "chevron-left",
    "chevron-right": "chevron-right",
    check: "check",
    add: "plus",
    remove: "minus",
    // The prototype's own actions.
    "content-copy": "copy",
    keep: "pin",
    "push-pin": "pin",
    "check-circle": "done",
    // Frame header and add rail.
    "open-in-new": "external",
    fullscreen: "present",
    "crop-square": "only",
    compare: "compare",
    tune: "sliders",
    "view-column": "columns",
    "filter-list": "filter",
    link: "link",
    "library-add": "duplicate",
    history: "up",
    // Sizes.
    "swap-horiz": "responsive",
    "web-asset": "window",
    "phone-iphone": "phone",
    "tablet-mac": "tablet",
    "laptop-mac": "laptop",
    "desktop-windows": "desktop",
    computer: "wide",
    description: "page",
  },
});

/** A glyph name of {@link prototypesIcons}. */
export type PrototypesGlyph = keyof typeof prototypesIcons.glyphs;
