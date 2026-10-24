# Home launcher — spacing and greys to match the mock

Follow-up to [`2026-09-16-global-home-launcher-implementation-plan.md`](2026-09-16-global-home-launcher-implementation-plan.md)
(shipped in `7afb85b49`). Target unchanged: `proto-1789509871-llga` at
`style=flat, palette=ocean, surface=black, header=capsule`.

## Context

`/home` ships tighter and flatter than the approved mock. The user wants the page
to breathe like the mock does.

1. **Spacing.** Every gap was rounded *down* to the spacing scale, and the gap
   between the capsule bar and the tiles is ~48px instead of ~70px. That last gap
   is small because the capsule and the tile grid are drawn by two different
   shared pieces inside the DataView, and Home's page can't reach between them —
   so a stopgap `pt-2xl` was put on the shared icons view.
2. **Greys.** The mock has two grey tiers (muted 0.7, faint 0.52). The app has
   one. So the capsule's filter/sort/fields circles render near-white (a ghost
   button has no resting colour and inherits the text colour), and the subtitle,
   search icon and placeholder use the brighter grey.

## Decision: stay on the spacing scale; one exception, for page geometry

The scale is `2xs 2 · xs 4 · sm 8 · md 12 · lg 16 · xl 24 · 2xl 32`, and it
tightens with the density theme. The mock's 6 / 26 / 14 are eyeballed values
between steps, not intentional ones. Hardcoding them would freeze a handful of
gaps while every neighbouring padding still follows density.

- **Gaps inside the layout round UP to the next step** — no lint exceptions.
- **Only the capsule→grid gap is off-scale** (~60px, above the scale's top step).
  That is page geometry, the same kind as the page's existing 64px margin, and is
  declared once, with its reason, in the capsule arrangement (below).

| Gap | Mock | Now | After |
|---|---|---|---|
| Title → subtitle | 6 | 4 (`xs`) | 8 (`sm`) |
| Subtitle → capsule pill | 26 | 16 + 8 capsule band | 24 (`xl`) + 8 = 32 |
| Capsule pill → tile top | 70 | 8 + 32 + 8 | 8 band + 50 + 12 tile pad = 70 |
| Tile top padding | 10 | 8 (`sm`) | 12 (`md`) |
| Tile row gap | 26 | 24 (`xl`) | 32 (`2xl`) |
| Tile column gap (wide) | 14 | 12 (`md`) | 16 (`lg`) |
| Page column | 920 | 920 | 932 (7·116 + 6·16 + 24) |

Tile glyph→name gap stays `md` (mock 11); bottom padding stays `sm` (mock 8);
narrow (<760px) gaps unchanged.

## Changes

### 1. Space below a toolbar arrangement — `primitives/data-view`

Remove the Home-shaped padding from the shared icons view, and give the space to
its owner: the capsule is a floating pill that sits apart from the content; the
default bar sits flush.

- `ToolbarArrangement` (`data-view/core/internal/toolbar-arrangement.ts`) gains
  `spaceBelow?: string` — a CSS length the host puts **between** the sticky
  toolbar band and the body. It is outside the `<Sticky>`, so the pinned band
  does not grow and `--dv-header-offset` is unchanged.
- The host (where `DataViewToolbar` and the view body are siblings) applies it
  as the body's top padding when the arrangement is in use. The compact fold
  ignores it (narrow panes keep their tight rhythm). `barArrangement` leaves it
  unset → every existing DataView is unchanged.
- `capsuleToolbar` sets `spaceBelow: "50px"`, commented: mock's 60px margin less
  the capsule band's own 8px bottom, plus the tile's 12px padding ≈ the mock's 70.
- `icons-view.tsx`: drop `pt-2xl` from both grid paths (plain and windowed);
  tile padding `pt-sm` → `pt-md`; `gap="xl"` → `gap="2xl"`; `GRID_GEOMETRY`
  wide column gap `gap-x-md` → `gap-x-lg`; bump the windowed `estimateSize`
  (124 → ~136) to match the new row height. Update the geometry comment.

### 2. A faint text tier — `ui/tokens/color-palette` + `css/text`

A real palette token, so any theme can set it and the shared capsule can use it
without knowing about Home.

- `color-palette/core/group.ts`: add `faintForeground` ("Faint text"). Schema
  defaults dimmer than `mutedForeground`: light `oklch(0.7 0 0)`, dark
  `oklch(0.48 0 0)`. Add it to the customizer's "Muted" row group.
- `ui-kit/web/theme/app.css`: `--color-faint-foreground: var(--faint-foreground);`
  next to muted (so `text-faint-foreground` / `placeholder:text-faint-foreground`
  exist; `css-vars-supplied` must pass).
- tweakcn has no such token: imported themes get the schema default (neutral
  grey). Acceptable; noted, not mapped.
- Home theme (`home/plugins/shell/web/internal/theme.ts`): dark
  `oklch(0.52 0 0)`, light `oklch(0.62 0 0)`.
- `Text`: add `tone="faint"` → `text-faint-foreground`.

### 3. Apply the two tiers

| Element | Tier | Where |
|---|---|---|
| Home subtitle | faint | `home-layout.tsx`: `tone="faint"` |
| Filter / sort / fields circles (at rest) | faint, → text on hover | `control-trigger.tsx` and `compact-controls.tsx`: the `round` form adds `text-faint-foreground` on the ghost state (ghost's own `hover:text-foreground` / `aria-expanded` already lift it). The `ghost` bar form is untouched. |
| Search icon + placeholder | faint | `search-input.tsx` `bare` appearance only: wrapper `text-faint-foreground`, input `placeholder:text-faint-foreground` |
| View chip icon | muted | `collapsed-view-switcher.tsx`: `<ActiveIcon className="text-muted-foreground" />` |
| View chip chevron | faint | same file: `<MdExpandMore className="text-faint-foreground" />` |
| App names | muted → text on hover | already correct |

### 4. Home layout — `home/plugins/shell/web/components/home-layout.tsx`

- Header `Stack gap="xs"` → `gap="sm"`; outer `Stack gap="lg"` → `gap="xl"`.
- Column `min(920px, …)` → `min(932px, …)`; update the lint-disable reason
  (seven 116px cells + 16px gaps).

## Files

- `plugins/primitives/plugins/data-view/core/internal/toolbar-arrangement.ts`, the data-view host that renders toolbar + body
- `plugins/primitives/plugins/data-view/plugins/capsule-toolbar/web/internal/capsule-toolbar.tsx`
- `plugins/primitives/plugins/data-view/plugins/icons/web/components/icons-view.tsx`
- `plugins/primitives/plugins/data-view/web/components/toolbar/{control-trigger,compact-controls}.tsx`
- `plugins/primitives/plugins/data-view/plugins/view-core/web/components/collapsed-view-switcher.tsx`
- `plugins/primitives/plugins/search/web/internal/search-input.tsx`
- `plugins/primitives/plugins/css/plugins/text/web/internal/text.tsx`
- `plugins/ui/plugins/tokens/plugins/color-palette/{core/group.ts,web/components/color-palette-section.tsx}`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`
- `plugins/apps/plugins/home/plugins/shell/web/{components/home-layout.tsx,internal/theme.ts}`
- CLAUDE.md prose where these APIs are described (data-view toolbar arrangement, icons, text tones).

## Verification

- `./equin test plugins/primitives/plugins/data-view plugins/primitives/plugins/search plugins/primitives/plugins/css/plugins/text`
  (capsule-toolbar, icons-view, search-input tests; add a case that `spaceBelow` lands outside the sticky band).
- `./equin build` (runs checks: spacing lint, css-vars-supplied, docs in sync).
- `compare-diff.ts --name proto-1789509871-llga --options style=flat,palette=ocean,surface=black,header=capsule --width 1280`
  — differing-pixel ratio below the `7afb85b49` baseline (run it once before the change to record it); check the gaps and greys by eye on the side-by-side sheet. Repeat at `--width 700`.
- `screenshot.ts --path /home` dark and light; hover a control circle → turns white.
- Another DataView with the default bar (e.g. tasks list) looks identical before/after.
- `./equin run plugins/apps/plugins/home/e2e/launcher.ts` passes.
