# Infra iceberg prototype — card kit, card runtime, one card per file

Prototype: `proto-1790334655-cs0c` (lives in `~/.singularity/apps/prototypes/proto-1790334655-cs0c/`, not in the repo).

## Context

The iceberg page has 27 mockup "cards" (one per item that has a viz key in `data.js`). They grew in three
files, each with its own drawing helpers, its own state/animation engine and its own CSS, plus a fourth set
inline in `index.html`:

| file | drawing | state engine | autoplay |
|---|---|---|---|
| `index.html` inline `VIZ` | SVG via `box/cyl/pulse` | none (SMIL only) | — |
| `viz-arch.js` | SVG via `vza*` | `data-s` + `data-show` + setTimeout chains + one-shot SMIL | none |
| `viz-shell.js` | mostly HTML spans via `btn/win/ln/t` | ad hoc per card, `innerHTML` rebuilds | `AUTO` 2600 ms interval |
| `viz-system.js` | SVG via `vzy*` | `data-s` + CSS `[data-w]` gating | 200 ms interval, `.vzy-auto` |

Every recurring bug of the last rounds traces to this split:

- **flicker** — a card rebuilds its whole DOM on click (plugtree, dataview, optimistic, window per frame);
- **animations that don't replay / everything appears at once** — whether a piece animates depends on
  which engine and which trick (display toggle, mask, `data-s=""` reflow hack) the card happens to use;
- **inconsistent style** — 9 font sizes, ~15 radii, ~12 stroke widths, 3 arrow styles, 4 chip styles,
  2 identical "filler line" classes; SVG text renders at 0.85× (360-unit viewBox in a 306 px box) while
  HTML text renders at 1×;
- **leaks & traps** — SMIL runs in hidden cards from page load, timers are never cleared on close,
  document listeners have no teardown, the wheel is trapped, clicks on a card's non-control area fold it,
  `role=button` spans have no keyboard activation;
- **dead code** — inline `gateway`, `dataview`, `reports` (overridden), `vzyPill`, several unused classes.

Outcome: one **kit** (tokens + primitives), one **runtime** (mount/unmount, state, autoplay, actions,
cleanup), **one self-contained file per card**, and a **gallery** page to check every card at once. The
same class of bug is then fixed once, in the runtime, for every card.

Decisions (agreed with the user):
- Keep **both HTML and SVG** cards, on one kit (same tokens, runtime, primitives).
- **Fix known behaviour bugs while porting** (list in step 4).

## Design

### Files (still one flat folder; must open by double-click)

```
index.html      page only: iceberg, layers, open/close, gauge. No mockup code.
gallery.html    every card, side by side, in the sunlit and the deep palette.
data.js         layers + items (unchanged format) — the single list of cards.
kit.css         tokens (both palettes), primitive classes, keyframes, reduced-motion.
kit.js          runtime (defineCard, mount/unmount, state, autoplay, actions, ctx) + drawing primitives.
card-<key>.js   one file per card: its picture, states, actions, caption. 27 files.
```

`kit.js` loads the card files itself from the viz keys in `data.js` (appending `<script src="card-<key>.js">`
— works on `file://`), so adding a card is: add the item in `data.js` + drop in `card-<key>.js`.
`viz-arch.js`, `viz-shell.js`, `viz-system.js` and the inline `VIZ`/`box`/`cyl`/`pulse` are deleted at the end.

### Tokens (`kit.css`)

One scale, defined once and used by HTML and SVG primitives alike:

- palette: `--k-bg --k-ink --k-soft --k-line --k-accent --k-mute` with two sets, `.k-sun` and `.k-deep`
  (today's sunlit / deep values). The page puts the class on each layer; the gallery on each cell. The
  `split=tint` loop accent stays one rule (`[data-k=loop]` → amber `--k-accent`).
- type: `--k-fs-sm` (9.5px), `--k-fs` (10.5px), `--k-fs-lg` (11.5px), weights 500/600.
- shape: radius `--k-r-sm` 5 / `--k-r` 7 / `--k-r-lg` 12 / pill; strokes hair 1, line 1.2, accent 1.6,
  bold 2; one dash `4 3`; mute opacities `.55` and `.3`.
- motion: `--k-fast .2s`, `--k-med .35s`, `--k-draw .55s`, one easing; keyframes `k-in` (fade+rise),
  `k-draw` (stroke reveal), `k-spin`, `k-pulse`; all off under `prefers-reduced-motion`.

**SVG renders 1:1 with HTML**: the kit's SVG root uses a viewBox as wide as the card's inner box
(standard 306, wide 486 — derived from the card width tokens), so `--k-fs` means the same pixels in both.
Ported SVG cards are re-laid out on that grid (not scaled).

### Primitives (`kit.js`, returning markup strings)

SVG: `text`, `box` (plain card, optional title/sub), `plugin` (the plugin card — one look everywhere),
`chip` (pill, optional `on` states), `button` (action control), `link` (the ONE connector: curve, `uses` |
`plugs` style, arrowhead, optional `draw`), `legend`, `icon` (Lucide set, incl. today's box/hammer/
lightbulb/star), `codeLines`, `cylinder`, `window` (mini browser/app frame), `dot` (travelling token),
`check`, `spinner`.
HTML: `hbtn`, `segmented`, `hchip`, `appFrame`, `bar` (filler line).
No card writes a raw `<rect class="v-box">` or its own arrow again; the old `.v-*` classes become kit classes.

### Runtime (`kit.js`)

```js
defineCard("plugtree", {
  caption: "…",
  width: "std" | "wide",
  states: 3,                       // optional; omitted = static card
  autoplay: { seq: [0, 1, 2], every: 1700 },   // optional
  render: (k) => `…`,              // markup; pieces gated with data-in="1 2"
  actions: { open: (ctx, el) => {…} },         // data-act="open"
  mount: (ctx) => {…},             // optional imperative setup (window, plugtree, hover)
});
```

- **Mount on open, unmount on close.** The page calls `Cards.open(itemEl)` / `Cards.close(itemEl)` inside
  `holdStill`'s `change()` (so FLIP measures the mounted size). Closed cards hold no mockup DOM → no SMIL
  in hidden cards, nothing for the 140 ms close ghost to animate (it clones a still frame).
- **`ctx`** is the only way to touch time or the document: `ctx.go(s)`, `ctx.state`, `ctx.after(ms, fn)`,
  `ctx.frame(fn)`, `ctx.on(target, type, fn)`, `ctx.run([[ms, state], …])` (sequence; controls marked
  `data-busy` are disabled until it ends). Everything registered through `ctx` is disposed on unmount.
- **State changes never rebuild.** `go(s)` flips `data-s` on the root; CSS shows `[data-in~=s]` pieces.
  The runtime diffs old→new visible set and adds `.k-enter` only to pieces that just appeared (so a link
  that stays plugged does not redraw; a new one draws). Cards needing geometry changes (plugtree) update
  attributes in place via `mount` helpers — `innerHTML` on a mounted card is a lint-by-review rule.
- **One autoplay clock** for the page: ticks only cards that are open AND on screen (one
  IntersectionObserver), stops for good on the first user action in that card, off under reduced motion.
- **Actions**: one delegated click + Enter/Space keydown on `[data-act]`; clicks anywhere inside `.vz`
  never fold the card (the page's fold handler ignores them).
- **Hover helper** for graphs: `ctx.highlight(id)` given an edge list — used by plugtree, profiling.

### Page changes (`index.html`)

- Remove inline `VIZ`, `box/cyl/pulse`, the `VIZ_EXTRA` merge, the `.v-*` classes and the
  `.vz-wide` `:has()` rule (width comes from the card's `width`).
- `renderDive` emits an empty `.vz` + `.cap` shell (`data-card=<key>`); call `Cards.open/close` in
  `toggleInline` / `expandAll`; put `.k-sun` / `.k-deep` on layers; load `kit.css` + `kit.js`.
- Keep everything else (berg, FLIP, gauge, options) untouched.

### Gallery (`gallery.html`)

Loads `data.js`, `kit.css`, `kit.js`; renders every card twice (sunlit + deep cell) at its real width,
grouped by layer, mounted and autoplaying; a toolbar to pause all / step all states. Reports in the page
(and console) any viz key with no card file or any action with no handler. It is the reference picture
for consistency reviews and for agents' screenshots.

## Steps

1. **Baseline.** Screenshot every card as it is today (open each item, both default and one interacted
   state) into the scratchpad — the "before" set the port is compared against.
2. **Foundation** (one agent, sequential): `kit.css`, `kit.js` runtime + primitives, `gallery.html`,
   page changes; port 3 reference cards that exercise every runtime feature — `plugin` (static SVG),
   `slots` (states + autoplay + draw links), `plugtree` (mount + in-place relayout + hover). Review with
   the user before step 3.
3. **Port the rest** in parallel, 3 agents by former file, each card onto the kit with the same picture:
   - arch: `gateway`, `central`, `hotswap`, `envs`, `durable` + inline `live`, `forks`, `loop`;
   - shell (HTML): `tabs`, `themes`, `layout`, `dataview`, `crossapp`, `status`, `mentions`, `isolation`,
     `optimistic`, `window`;
   - system: `compose`, `reports`, `triggers`, `migrations`, `ladder`, `profiling`.
4. **Behaviour fixes folded into the port**: hotswap/durable buttons disabled while running
   (`ctx.run`); isolation and optimistic get a reset; slots gets a step control; ladder's "Docs" rung
   reachable; migrations returns to its finished picture; crossapp autoplays; profiling resets on leave;
   window renders rows without per-frame `innerHTML` and stops trapping the wheel outside its viewport.
5. **Delete** `viz-*.js`, dead classes and helpers; grep that no card uses `innerHTML` on its mounted root,
   raw `setTimeout`/`setInterval`/`addEventListener`, or a hard-coded font size / radius / stroke.

## Verification

- `gallery.html` opens by double-click and from `http://singularity.localhost:9000/prototypes/proto/proto-1790334655-cs0c`;
  zero console errors; every data.js viz key renders in both palettes.
- Headless screenshots (Playwright via `./equin run`, headless shell from the `chromium` dep) of the
  gallery and of each opened card in the page, compared side by side with the step-1 baseline: same
  picture, consistent type/strokes.
- Per-card scripted checks: autoplay advances only while open and on screen; first click stops it;
  closing a card leaves no running timers (runtime exposes a live count of `ctx` disposables — must be 0
  after close); a newly appearing link/piece animates, persisting ones don't (frozen-frame screenshot at
  mid-animation, as done for slots); opening/closing an app in plugtree does not recreate nodes.
- Page regressions: open/close FLIP, Expand all, `split` / `finish` / `header` options, phone width.
