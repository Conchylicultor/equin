# Prototypes viewer redesign — port of proto-1792527153-l4fzh8

The mockup: `~/.singularity/apps/prototypes/proto-1792527153-l4fzh8/index.html`
(view: `http://singularity.localhost:9000/api/prototypes/proto-1792527153-l4fzh8/index.html?tone=neutral`).
It mocks the canvas pane (`route:/prototypes/proto/<id>`). The user's picks:
**tone = neutral**, **chrome = always** (no fade), **accent = apricot `#e0ad80`**.
Goal: the real app is pixel-perfect with the mock: colours, type, radii, icons,
menus, hover reveals and animations. Every existing feature stays (link, spread,
color swatches, option groups, swipe, Whole page, width slider, version row
actions, Make vN the latest, launch popover…), restyled in the mock's language;
only what the mock explicitly drops goes.

## What changes (mock → app)

1. **Theme** — the Prototypes app gets its own designed theme `prototypes`
   (like `files`, `sonata`): the mock's neutral-tone greys, apricot accent,
   Geist / Geist Mono, 13px/1.4 base, its radii. Selected in
   `config/ui/theme-engine/@app/prototypes/theme.jsonc`. Dark-only values (the
   mock is dark), written for both modes.
2. **Icons** — an inline icon family `prototypes` (precedent:
   `apps/sonata/primitives/icons`) holding the mock's own glyph bodies (24-unit
   box, stroke 1.6, round caps/joins), mapping the Material symbol names the
   prototypes app draws, plus app-only glyphs (compare, keep-only, responsive…).
   Fallback `lucide`. Selected by the theme's `iconFamily`.
3. **Glass float surface** — one reusable look for every floating piece of
   chrome (`.float` in the mock): surface at 86% over a 20px blur + saturate
   150%, 1px line-2 border, 14px radius, shadow
   `0 12px 40px -12px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.05)`.
   Used by the header card, the bottom dock and the add rail buttons.
4. **Pane header → floating card, top-left** (`.top-l`): 12px from the top/left
   edges, 42px tall, padding 0 6px, gap 2px: All apps (grid), Back, breadcrumb
   `Prototypes / <title>` (parent in dim, `/` in faint, title 500 weight,
   ellipsized; parent+sep hide < 1150px), then Copy ID, Pin, Done as 26px icon
   buttons at .85 opacity (hidden < 900px). No full-width bar; the canvas runs
   under it edge to edge. Icon buttons: 30×30, radius 7, muted → text on hover
   with a raise-2 wash; toggled-on (pinned/done) = accent colour.
5. **Canvas** — fills the whole pane. Background: the 28px grid
   (`rgba(255,255,255,.036)` 1px lines) under a radial vignette
   (`ellipse 90% 85% at 50% 50%, transparent 55%, bg 100%`). Room left for the
   chrome: top 66 + header 34, bottom 76, left 16, right 24; frames 20px apart,
   centred; each frame its share. Frame: radius 12 (phone 28, tablet 20),
   `box-shadow: 0 0 0 1px line-2, 0 30px 80px -24px rgba(0,0,0,.75)`.
   Geometry animates (left/top/width/height .35s cubic-bezier(.2,.8,.2,1),
   radius .35s). No selection highlight.
6. **Frame header** (26px high, 6px above the frame): one box (`.fbox`, 28px,
   1px line border, radius 9, surface at 70%) holding the **options chip**
   (sliders icon · "Empty · Dark" · "+3" mono dim · chevron-down) | a 14px
   divider | the **version stepper** (‹ 20px · `v24` mono 500 + "latest"/"6d
   ago" dim + chevron · › 20px; disabled arrows at .3). Right side: the frame
   actions, revealed on hover (opacity .15s): Open in a new tab, Full screen,
   Close others, Close (24px buttons, 14px glyphs). A source frame shows a
   dashed "Real app" tag instead of the box. A narrow frame (< 440px) drops
   "+N", the "latest" label and the chip's chevron.
   The options pill no longer floats over the frame: the chip in the header
   opens the Options popover under it.
7. **Popovers** (all): `--pop` background, 1px line-2 border, radius 14,
   padding 6, shadow `0 24px 60px -16px rgba(0,0,0,.8), inset 0 1px 0
   rgba(255,255,255,.04)`, entering with `popin` (.14s ease-out from
   `translateY(4px) scale(.98)`, opacity 0). Header row `.ph` (8px 10px, h5 12px
   500 muted). Rows radius 9, hover raise.
   - **Options** (520px): `Options · <frame name>`; rows: 84px label | value
     pills (24px, radius 7, selected = accent-soft fill + accent-line border) |
     trailing 26px split ("One frame per value") icon at .4 opacity → 1 on row
     hover. Keep link, groups and color swatches in this language.
   - **Versions** (440px): "25 versions" + a "This variant" filter chip; rows
     grid 34px | 1fr | auto: `v12` mono (accent when current) · request
     (ellipsized, muted unless current) · when (mono 11px dim, "latest"). Current
     row raise-2. Max-height 340 scroll. Keep the row actions and "Make vN the
     latest".
   - **Size** (300px, opens above the dock): "Size"; preset list (18px check
     slot · 18px icon · name · dims mono 11px dim; current in text colour with an
     accent check); sections divided by a line: `Width <b>838px</b>` + slider;
     `Zoom <b>100%</b>` + Fit button, −, slider, +; `Whole page` (page icon,
     switch 28×16). Slider: 4px track line-2, accent fill, 12px text-colour knob
     with a 3px accent-soft ring. Switch: on = accent with bg knob, knob slides
     .15s.
8. **Add rail** — `+` and Compare (30px, radius 9, the glass look, text colour)
   straddling the last frame's right border at mid-height, revealed on hover.
9. **Bottom dock** — glass float centred 12px above the bottom, padding 5, gap
   4: three device buttons (Responsive, This window, Phone; the current one
   `on`: raise-2 + inset line-2 ring), a 18px divider, and the size button
   (`838 × 724` mono 11.5 with numbers in text 500, then the zoom % in dim only
   when scaled < 100%) opening the Size popover. Replaces the bottom-right size
   chip.
10. **Tooltips** — inverted (text bg, bg ink), 500 11.5px, padding 4px 8px,
    radius 6, 6px below (8px above for dock buttons).
11. **Full screen** — the frame grows from its place to the whole canvas
    (same .35s geometry transition), header/chrome fade out; Esc returns.

## Work split

Phase 1 (one agent): theme, icon family, glass surface primitive — the
vocabulary everything else uses.
Phase 2 (parallel): (A) floating pane header + canvas background/frame/geometry
+ add rail + swipe toggle + full screen; (B) frame header box + Options and
Versions popovers; (C) bottom dock + Size popover.
