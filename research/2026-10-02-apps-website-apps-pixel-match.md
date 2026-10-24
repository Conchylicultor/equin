# Website Apps page ↔ proto-1790867857-hug2 pixel match

## Context

`/website/apps` (plugin `plugins/apps/plugins/website/plugins/pages/plugins/apps`) was built from
`proto-1790867857-hug2` (`stage=today, end-cards=question`) but still differs visibly:
`compare-diff.ts --options end-cards=question` reports **5.70 %** differing pixels at 1920×1080, with
the hot cells over the hero, chips and card grid. Goal: zero intended differences. Default = change the
app; where changing the app has a real cost (site-wide inconsistency, API can't express it, app is
arguably better) we **add a variant to the mock** (defaults untouched, so the original still renders
byte-identical) and the user picks.

Phase 1 (this round): add the variants to the prototype only. Phase 2 (after agreement): implement.

Captures: scratchpad `cmp-*.png` (canvas compare), `mock-full-before.png` / `app-full-before.png`
(1920×3400). Note: this worktree has no build (build was denied), so the comparison ran against main
via `--url http://singularity.localhost:9000` — main is at this branch's commit.

## Difference inventory

### A. App-only fixes (no caveat — just make the app match)

| # | Area | Mock | App today | Fix |
|---|------|------|-----------|-----|
| A1 | Site header inset | wordmark/nav on the content edges | wordmark at 16 px, nav flush right (full bleed) | Regression: the equin-document `chromePadX` (measure gutter) isn't reaching the pane header — likely `--chrome-pane-pad-start/end` resolved at `:root` before the sub-theme overrides `--chrome-pad-x`. Fix in the token plumbing (`ui-kit/theme/app.css` / density group), not on this page. Affects every website page (intended behaviour per `website-band.css`). |
| A2 | Filter chips | outlined pills (1px 16 % white), active = white fill / black text, 13.5 px, `6×14` pad; row `26/18` pad + hairline | ghost `FilterChip` (no border, active = muted fill), band `page` padding 48 px above | Add an `outline` look to `FilterChip` → `ToggleChip` (inactive = `BORDERED_OFF` minus bg; active = `secondary` fill, which equin paints white/black). Chips row padding to 26/18. |
| A3 | Card chrome | padding 18, radius 18, 1 px 8 % border; thumb inset −6 (12 px from edge), radius 12, bg `#0a1020` | `padCard` 34 px, `rounded-2xl` 20 px | Card padding/radius per card (Card inset prop / class), thumb negative margin, thumb bg. |
| A4 | Grid | `minmax(250px,1fr)`, gap 16 → 4 cols | `minCellWidth 15.5rem`, gap `lg` 20 → 3 cols | gap → 16 (`space-md`=14 / new token?) and cell min → 250; column count also depends on B1. |
| A5 | Install button | pill 12.5 px/600, `5×13` pad (~28 px), 4 % white fill, 16 % border | outline pill `md` (44 px) | `Button size="xs"`/`sm` + fill class. |
| A6 | Third grey tier | sub-lines, "The harness", captions in `--fg3 #71717a` | `muted` (#b4b4bd-ish) everywhere | Use `Text tone="faint"`; set `faintForeground` in the equin palette (`shell/web/internal/theme.ts`) to #71717a-equivalent. |
| A7 | Search field | 560×50, radius 14, 1 px 16 % border, panel@85 % fill, `0 20 40 -30` shadow, kbd as a bordered 11 px mono box; 34 px under lede; focus ring = accent border + 4 px glow | 560×48, `rounded-2xl`, faint border, no shadow, kbd style differs; 28 px gap | Restyle in `apps-search.tsx` (height, radius, border `input`, shadow, focus); kbd per mock. |
| A8 | Group head spacing | section pad 34 top, head→grid 16, h3 600 weight | `Stack gap 2xl/lg` | Match paddings/gaps. |
| A9 | Card internals | icon 52, gap 14; name 16/600; desc margin 14/16, line-height 1.5; drawn-thumb `.rail` hidden | close but off by several px | Align gaps/margins. |
| A10 | Closing (compose + read-next) + footer | compose: dashed 20 % border, `30×34` pad, radius 22, input 42 h; read-next pad `26×28`, radius 20, q 19 px/1.35; footer margin-top 64 | not yet compared (pane scroll cut off the capture) | Capture with a scrolled shot during phase 2 and align the same way. |

### B. Caveat candidates → new mock variants (user decides)

Each becomes one `<meta name="prototype-option">` whose **first value is the current mock** (default
unchanged) and second value draws what the app does.

| # | Option (`name: mock | app`) | Mock | App | Why it's a caveat |
|---|---|---|---|---|---|
| B1 | `measure: 1120 \| 1040` | `.wrap` 1120 px | `--website-measure` 65 rem = 1040 px | Site-wide token; every other website page is on 1040. Changing it moves all pages; page-local widening breaks the shared left edge rule (`WebsiteBand`). With 1040 the grid holds 3 cols at 250 px min (4 cols would need min ≤ 248 with gap 16 → shown in the variant as 4 × ~248). |
| B2 | `hero: mock \| site` | h1 58 px (clamp), lede 18 px / 640 max, 72 px top pad | shared `WebsiteHero`: display 78 px, lede 19 px / 720 max, `page-hero` 88/48 | `WebsiteHero` + type scale are shared by every website page. |
| B3 | `header: mock \| site` | text-only Improve pill, no GitHub | GitHub icon link + ✦ sparkle on Improve, nav labels on the site's label rung | Header is the shared `WebsiteHeader` slot; the extras exist on all pages. |
| B4 | `icons: gradient \| tile` | 52 px gradient tile (c1→c2 140°), white outlined glyph, inset highlight | `Avatar` `tile` presentation: flat categorical fill, categorical-foreground glyph at 46 % | `Avatar` can't express a gradient; the flat tile is how the app rail / Home draw the same apps (consistency argument for the app). A `gradient` presentation could be added to the avatar primitive if the mock wins. |
| B5 | `type: mock \| site-scale` | 20 px group head, 16 px name, 14 px/1.5 desc, 12.5 px meta | site rungs: heading 24, body 15.5/1.6, label 14/1.6, caption 12 | `no-adhoc-typography` allows only the type-scale rungs; 20 / 16 / 12.5 have no rung in `equin-document`. Options: snap mock to the rungs (variant), or add rungs to the site scale (affects nothing else but grows the scale). |
| B6 | `search-icon: stroke \| symbol` (minor) | hand-drawn stroked SVG magnifier | `SearchInput`'s Material `search` symbol | Primitive owns its icon; app's icon system is consistent across the product. |

Everything not listed in B is treated as A (app changes).

## Decisions (2026-10-02, with the user)

| # | Decision | Consequence |
|---|---|---|
| B1 measure | **1040, 4 per row** | Keep `--website-measure`; app grid → 4 cols (`minmax(240px)` / 16 px gap ⇒ 248 px cards). Mock option `measure=site-1040` draws it; compare with `--options end-cards=question,measure=site-1040`. |
| B2 hero | **homepage big, inner pages small (the mock)** | `WebsiteHero kind="page"` takes the mock's 58 px heading / 18 px lede / 640 px cap / 72 px top / 34 px to the search; `kind="home"` unchanged. Moves every inner page. |
| B3 header | **site header; mock updated** | Mock now draws the GitHub button + ✦ Improve as its design (option removed). App: only the A1 inset fix. |
| B4 icons | **gradient (the mock)** | Avatar primitive gains a gradient tile presentation (c1→c2 140°, white glyph, inset highlight + drop shadow); catalog carries the two stops. |
| B5 type | **mock sizes** | Add the missing rungs to the equin-document scale (20, 16, 13.5, 12.5, 10.5, …) or page-local Text roles — decide the cleanest spelling at implementation. |
| B6 search-icon | **app's symbol; mock updated** | Mock now draws the Material `search` glyph (option removed). |

Mock options remaining for comparison: `measure`, `hero`, `icons`, `type` (defaults = mock).

## Phase 1 — prototype changes (only file touched: `~/.singularity/apps/prototypes/proto-1790867857-hug2/index.html`)

- Add six `<meta name="prototype-option">` lines (B1–B6), first value = current look.
- Each option is a `data-<name>` attribute on `<html>`; CSS overrides keyed on the non-default value
  only (`:root[data-measure="1040"] .wrap { width: min(1040px, 100% - 56px) }`, etc.), so the default
  render is byte-identical to today.
- B3 adds the GitHub icon + sparkle markup hidden unless `data-header="site"`; B4 adds a flat-tile style
  using the app's categorical colours (hard-coded hexes read from the app's resolved `--categorical-N`).
- Follow `prototypes/CLAUDE.md` (read first; never open another prototype's folder).
- Verify: `compare-diff.ts --name proto-1790867857-hug2 --options end-cards=question` with the defaults
  still produces the same mock capture; then once with all `app`-side values to show the residual diff is
  only the A-list.

Then ask the user, per B-row, mock vs app.

## Phase 2 — implementation (after agreement; not started)

Files: `pages/plugins/apps/web/components/{app-card,apps-gallery,apps-search,apps-closing}.tsx`,
`apps-gallery.css`; `shell/web/internal/theme.ts` (faint tone, any agreed scale/measure change);
`primitives/plugins/filter-chips` + `css/plugins/toggle-chip` (outline look); the chrome-pad token
plumbing for A1; `primitives/plugins/avatar` only if B4 = gradient. Then `./equin build`,
`compare-diff.ts … --options end-cards=question,<agreed picks>` until the mismatch is ~AA noise, and a
scrolled capture for A10.
