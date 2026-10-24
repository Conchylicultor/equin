# Website Apps page ↔ proto-1790867857-hug2 — phase 2 (implementation)

Follows `2026-10-02-apps-website-apps-pixel-match.md` (inventory + decisions). This doc is the
implementation plan for the decisions where the mock won.

## Context

Every mock-vs-app difference is decided. The app still differs (5.7 % at 1920×1080). This makes
`/website/apps` match the mock run with `end-cards=question,measure=site-1040` (and `icons=<pick>`, see
below). It covers the first screen plus the closing block, read-next cards and footer.

## Root causes found

- **Header full-bleed (every website page):** the pane header pads with `--chrome-pane-pad-start/end`
  (`bar.tsx` → `px-chrome-pane`, `ui-kit/theme/app.css`). Their default is `var(--chrome-pad-x)`, but
  that `var()` is resolved at `:root`. The equin-document sub-theme overrides only `--chrome-pad-x` on
  its own scope element, so the header never sees it.
  **Fix (structural):** `defineSubTheme` throws when a fragment names a token that another token of
  the same group derives from by default (`var(--x)`) but does not name that derived token. A CSS
  derived default is resolved where it is declared, so the override would never reach it. The website
  sub-theme then names `chromePanePadStart/End` too. This fails loudly at module eval for every future
  sub-theme.
- **Type rungs:** the type ladder is closed: `text-[13.5px]` is banned, and a theme cannot add roles.
  The sanctioned spelling for a region with other sizes is a **sub-theme** that re-values existing
  roles. Two new region sub-themes are added, both worn on top of equin-document.

## Changes

### Shell (`plugins/apps/plugins/website/plugins/shell`)
1. `internal/theme.ts`:
   - Fix the header gutter (`chromePanePadStart/End` = the measure gutter).
   - Set `faintForeground` in the equin palette to the mock's #71717a (dark) and an equivalent in light.
   - Add `equinPageHeroTheme`: display 58px/1.04, subheading 18px.
2. `WebsiteHero kind="page"`:
   - Wears `equinPageHeroTheme`.
   - New `page-hero` rhythm: 72px top, 36px bottom.
   - Heading tracking −0.045em, 18px heading→lede, lede capped at 640px, 34px lede→children.
   - `kind="home"` is unchanged. This moves all 6 inner pages (decided).
3. Footer small print uses `faint` (the mock's fg3).
4. Update `shell/CLAUDE.md` for the hero kinds and the header tokens.

### Primitives
- `ToggleChip` gains an `outline` variant:
  - off: 1px `input` (16 %) border, transparent fill.
  - on: `secondary` fill, which equin paints white with black text.
- `FilterChip` gains a `variant` prop (`ghost` default | `outline`).
- `theme-engine/core/sub-theme.ts` gets the derived-token guard above.

### Apps page (`pages/plugins/apps/web`)
- `equinGalleryTheme` sub-theme (contributed through `ThemeEngine.SubTheme`), worn by the gallery
  band:
  - Type: heading 20/600 (group head), subheading 16/600 (app name), body 14/1.5 (description,
    group line), label 13.5 (chips), caption and control 12.5 (category line, Install), tag 10.5 (Soon
    badge).
  - Density: `padCard` 18px; the control height for the 28px Install pill; spacing steps for
    8/12/14/16.
- **Chips:** `FilterChip variant="outline"`, row padding 26/18 with a hairline below.
- **Grid:** 4 columns at 1040px (min cell 240px, 16px gap). 34px above each group, 16px from heading
  to grid, 12px heading↔line, sub-line in `faint`.
- **Card:** 18px padding, 18px radius.
  - Picture inset −6px (12px from the card edge), 12px radius, #0a1020-equivalent bg (mixed from
    tokens).
  - 16px picture→top row, 14px icon↔name, desc margin 14/16.
  - Category line in `faint`.
- **Install:** small pill (~28px), 4 % foreground fill, 16 % border, 12.5/600, hover accent.
- **Soon** badge: 10.5px, bordered, `faint`.
- **App icon:** 52px, 15px radius, gradient at 140°, white outlined 28px glyph, inset highlight plus
  drop shadow. The colour source depends on the `icons` pick; see the open question.
- **Search:**
  - 560×50, 14px radius, 1px `input` border, card colour at 85 %, soft shadow.
  - The `/` kbd is bordered with no fill, 11px mono, `faint`.
  - Focus: primary border plus a 4px primary/36 % glow.
- **Closing:**
  - "Missing an app?": dashed 20 % border, 30×34 padding, 22px radius, 42px input, 40px above.
  - Read-next cards: 26×28 padding, 20px radius, question 19px/1.35, 64px above.
  - Footer: 64px above.

## Icon colours (decided 2026-10-06: palette deep)

The mock's `icons` option gained `palette-lift` / `palette-deep`. The user picked **palette deep**:
the gradient runs from the app's categorical slot darkened 0.28 in OKLCH lightness to the slot itself.
It is built as an `Avatar` `gradient` presentation (`primitives/avatar`). Compare with `icons=palette-deep`.

## Verification

- `./equin build`.
- `compare-diff.ts --name proto-1790867857-hug2 --options end-cards=question,measure=site-1040[,icons=…]`
  until only AA noise remains.
- A scrolled 1920×3400 screenshot of the app and of the mock for the closing block and footer.
- `site-chrome-verify.ts`, and a check that the header's padding-left equals (vw − 1040) / 2.
- Look at one other inner page (`/website/vision`) for the new hero.
