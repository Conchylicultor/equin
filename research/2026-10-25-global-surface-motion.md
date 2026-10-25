# Surface motion — floating surfaces animate by default

## Context

Floating cards don't animate when they appear, disappear or change shape (the Places list
panel ↔ its pill, the floating place card, the Ask equin card ↔ its pill, …). Each is written
as `cond ? <Surface/> : null` or `a ? <Pill/> : <Card/>`: React swaps the DOM in one commit,
so nothing persists for a transition to run on. The codebase's existing motion covers other
shapes only: `FoldMotion` (content folding inside a box that stays put), `FloatingAction`
(hover morph), miller `ColumnMotion`, the hints stage, sonata's dock. The goal: a floating
card animates **without its author asking**, and the few cases a primitive cannot see are
caught by lint.

Findings that shape the design:

- `OverlayPanel` already wears `data-open:overlay-enter`, driven by the overlay token group
  (`ui/tokens/overlay`: `overlayEnter{Duration,Easing,Translate,Scale}`), **default 0ms** — the
  hook is there, switched off. No exit (base-ui's `data-ending-style` is unused).
- The desktop launcher's `animate-in fade-in-0 …` classes are dead: no `tw-animate-css`, the
  utilities don't exist.
- `Pin` / `Placed` center with the CSS `translate` property → motion must animate only
  `opacity` / `scale` (never `translate` / `transform`) on any element that may be placed.
- Three `prefersReducedMotion()` copies (collapsible, sonata dock; CSS media queries).
- No presence / exit-retention helper exists.

## Design

Three mechanisms, each owned where it can be automatic:

### 1. Enter — on the surface, CSS, automatic

`Surface` levels `overlay` and `float` wear a `surface-enter` keyframe (new `@utility` in
`ui-kit/web/theme/app.css`): from `opacity: 0; scale: var(--overlay-enter-scale)`, over
`--overlay-enter-duration` / `--overlay-enter-easing` (the same overlay tokens — one motion
vocabulary for every floating thing). No `translate` (it would fight `Pin`/`Placed`
centering). Off under reduced motion. Every floating card animates in on mount with zero call
site changes.

The overlay token defaults become non-zero (`140ms`, `ease-out`, `0px 0px`, `0.98`, the
prototypes theme's values), which also switches on the popover/menu enter that `OverlayPanel`
already declared.

### 2. Size — on the surface, automatic (`useSizeMotion`)

`Surface` `overlay` / `float` tweens its own size (and corner radius) when **its content**
changes — so a card that turns into a pill, a list that drills into a detail, a thread that
grows, morph instead of jumping. Mechanism (new hook in `css/motion`):

- `ResizeObserver` reports the new border-box size; a `MutationObserver` (childList, subtree,
  characterData) marks "content changed". Only a size change preceded by a content change
  tweens — a window resize or a parent re-layout lands at once.
- WAAPI on the surface: `width` / `height` / `border-radius` from the last resting values to
  the new ones (`overflow: clip` while running), ~240 ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`.
  RO is delivered after layout, before paint, so the first frame is already the old size.
- While its own tween runs, RO reports are ignored; on finish it re-checks and tweens again if
  the content moved on (a streaming thread grows in steps).
- **Coexists with folds**: if anything else in the subtree is animating
  (`getAnimations({ subtree: true })`, minus its own), it does not tween — the inner
  `FoldMotion` already animates the size and the surface simply follows it frame by frame.
- No tween from/to a 0 size, under reduced motion, or where WAAPI is missing (jsdom).

### 3. Exit and swaps — `<Presence>` (the only part a call site writes)

A surface cannot animate its own unmount. `<Presence>{cond ? <X key=…/> : null}</Presence>`
keeps the leaving element drawn until its exit has run:

- One keyed child (`ReactElement | null | false | undefined`); identity = its `key`.
- Exit: the leaving element is kept **as the same instance** (its state intact), its caller
  `ref` swapped for Presence's own (so a `cardRef` never points at a ghost), made `inert` +
  `aria-hidden` + `pointer-events: none` imperatively, taken out of flow (`position:
  absolute` at its last offset box — so a swap or an in-flow sibling never jumps), and faded
  (`opacity` → 0, `scale` → the token) over 0.75× the enter duration; then dropped.
- Enter: if the entering child's subtree already animates (a `Surface` enters by itself),
  Presence does nothing; otherwise it plays the same enter on the root. No enter on first
  render.
- Swap (key A → key B): A exits as above while B enters — a cross-fade in place.
- Same key returning mid-exit: the exit is cancelled, the same instance comes back.
- Reduced motion / no WAAPI (jsdom): the leaving element is dropped in the same render —
  existing synchronous tests keep passing.
- Requirement: the child forwards `ref` to its root DOM element (Pin, Placed, Surface, Layer,
  Column … all do); a child that doesn't throws loudly in the commit.

### 4. Popover exit — `OverlayPanel`

`data-ending-style:overlay-exit` — the enter played back (to `opacity: 0`, the token
translate/scale, `forwards`, 0.75× duration). base-ui waits for the popup's animations before
unmounting / hiding, so every popover, menu and select gets an exit for free.

### 5. Lint backstop — `motion/no-unanimated-surface-exit`

Flags a JSX conditional (`x && <…>`, `x ? <…> : null`, `x ? null : <…>`) whose element is a
floating surface — `Pin` / `Placed` / `Layer` with `layer="float" | "overlay"`, `Surface`
with `level="overlay" | "float"`, or `ViewportOverlay` — that is not a direct child of
`<Presence>`. Composite children (`{open && <PlaceCard/>}`) are an accepted false negative;
the surface inside still gets enter + size for free. Genuine exceptions are declared in the
owning plugin's `exempt/index.ts`.

## Placement

New plugin **`primitives/css/plugins/motion`** (a sub-plugin of the `css` umbrella, not a new
top-level primitive): `prefersReducedMotion` (moved from collapsible; importers updated, the
sonata copy deleted), `useSizeMotion`, `Presence`, the lint rule. `Surface` imports it;
collapsible imports `prefersReducedMotion` from it (`startFold` stays the fold clock).

## Adopters

| Site | Change |
|---|---|
| Places list panel (DataView `asideEnd` card) | none — hidden pill ↔ list ↔ drilled card morph via the card's `useSizeMotion` |
| Places floating card | the two conditional `Pin`s merge into one always-mounted slot `Pin` (own ref, added to click-away panels) with `<Presence>` around the keyed `PlaceCard` / `GooglePlaceCard` — enter, exit, A→B cross-fade |
| Places Ask thread, tag manager, pin-pick bar | `<Presence>` around each conditional `Pin` |
| Ask equin | `ViewportOverlay` + `Placed` always mounted while not closed, under `<Presence>`; ONE `CardFrame` surface for every mode — the pill is that surface's content, so pill ↔ card ↔ empty morph by size |
| Map empty notice | `<Presence>` around the notice `Pin` |
| Page place-search suggestions | `<Presence>` (in-flow: the ghost leaves the flow) |
| Image-viewer shortcut sheet | `<Presence>` |
| Desktop launcher | dead `animate-in` classes removed (the `Surface` enters by itself); `<Presence>` for the exit (`LauncherPanel` forwards `ref`) |
| Every popover / menu / select | enter on (token default), exit via `overlay-exit` |

## Not migrated (and why)

- **Sonata section dock** keeps `useDockMorph`: a prototype-specified 400 ms clip-path morph
  of two distinct elements (rail → panel); folding it into size-motion would change the look.
  Only its duplicate `prefersReducedMotion` goes. Follow-up task.
- **Prototypes canvas `FrameCard`** — in-flow board items with their own geometry transition,
  letter attributes and extent reporting that an exiting copy would corrupt. Its
  `LaunchAgentPopover` is a popover → covered by #4.
- `FoldMotion`, `FloatingAction`, miller `ColumnMotion`, the hints stage, dialog/sheet,
  tooltips (instant by design) — untouched.

## Risks

- e2e that checks a surface is gone right after closing: exits are ≤ ~105 ms and exiting
  copies are `aria-hidden` (excluded from `getByRole`); the places `click-away` check waits
  800 ms.
- Size tweens on every overlay/float Surface: one RO + MO each, tweens only on content change.

## Verification

- `./equin test plugins/primitives/plugins/css/plugins/motion` — Presence (exit retention with a
  mocked `animate`, ref swap, synchronous drop without WAAPI, re-entry), lint rule cases.
- `./equin test` for collapsible, image-viewer, data-view, surface.
- `./equin build` (checks: lint incl. the new rule, type-check, boundaries).
- Drive the build with `browser_*`: /places — hide/show the list, open a place (panel and
  floating), switch places, open/close Ask; ? → Ask equin minimize/restore; a popover
  open/close. Screenshot mid-animation with `browser_javascript` reading
  `document.getAnimations()`.
- Places e2e: `click-away.ts`, `presets.ts`; Ask e2e `ask.ts`.
