# Small-end scale audit: spacing ramp, type, avatars

Question: the design scales are coarse at the small end and prototypes use values off them, so "pixel-perfect
from the prototype" cannot be reached. Candidates: 6px and 10px spacing, an 11px meta size, 22/28px avatars.
Measure first, then recommend. Read-only audit; the scanners are throwaway scripts in `/tmp/audit` (not committed).

## Method

**Scales (read from source).**
- Spacing ramp: `--space-{2xs..2xl}` in the density token group
  (`plugins/ui/plugins/tokens/plugins/density/core/group.ts`): 2, 4, 8, 12, 16, 24, 32 px, plus `none` = 0.
  The `@utility` classes exist for 14 families (gap, gap-x, gap-y, p, px, py, pt, pr, pb, pl, rail, rail-x, rail-y,
  rail-owe), generated into `space-ramp/core/ramp.generated.ts`. **There are no margin classes in the ramp.**
- Density presets (`density/web/shortcuts.ts`), px per step 2xs/xs/sm/md/lg/xl/2xl:
  - comfortable: 2 / 4 / 8 / 12 / 16 / 24 / 32
  - cozy: 2 / 3 / 6 / 10 / 14 / 20 / 28
  - compact: 1 / 2 / 4 / 8 / 12 / 16 / 24
- Type: roles in `text/core/roles.ts` with defaults caption 12, label 13, body 14, subheading 16, heading 18,
  title 20, display 48. **A sub-scale already exists: `text-2xs` = 11px (line 16) and `text-3xs` = 10px (line 14)**,
  tokens `font-size-2xs/3xs` (`type-scale/core/group.ts`).
- Avatar: `SIZE_MAP` in `avatar.tsx` is hard-coded Tailwind `size-4/6/8/12` (16/24/32/48) per `ControlSize`.
  It is not a token, so no theme can retune it. Control heights, in contrast, are density tokens
  (`controlHeightXs..Lg`, default 24/28/32/36).

**App code (A).** 11,719 `plugins/**/*.{ts,tsx,css}` files, excluding `*.test.*`, `*.generated.*`, `__tests__`,
`e2e/`, `testing/`, `node_modules`. Regex scan for: ramp classes (`gap|p*|rail*-<step>`), `<Stack gap>`,
`<Inset pad>`; raw Tailwind numerics (`gap-1.5`, `mr-1.5`, `p-2.5`, ...) resolved at 4px per unit; arbitrary
values (`gap-[7px]`, `size-[18px]`, `text-[10.5px]`); `eslint-disable` lines per rule; raw `px`/`rem` in `.css`
(`padding`, `margin`, `gap`, `font-size`, with `var()`/`calc()` excluded). The class scan is noisy by a handful of
sites (e.g. an SVG path string `m-4.5`), which does not move any conclusion. `./equin exempt list` shows **zero**
exemptions for `spacing/no-adhoc-spacing` and `text/no-adhoc-typography`: every escape is an inline
`eslint-disable` with a reason, so the disable counts below are the complete escape inventory for those two rules.

**Themes (A3).** All 25 code themes and sub-themes in `theme-declarations.generated.ts` (Mist included), every
density / type-scale token holding a plain px/rem length.

**Prototypes (B).** `~/.equin/apps/prototypes/`: 132 `proto-*` dirs plus `_template` (133; `_history`, `_picks`,
`_trash` skipped). Sources: every `*.css`, every `<style>` block and every `style="..."` attribute in `*.html`.
`calc/var/clamp` values skipped. `padding`/`margin` shorthands are split per side (CSS 1/2/3/4-value rules). A
"round element" is a rule with `border-radius: 50%|9999px|100%` whose `width` and `height` are equal px/rem.
Sheets identical by content hash in more than one prototype (4 copies of `mist.css` in 4 dirs sharing one hash,
2 more, `home.css` x2, `agent-icons.html` style x4, some inline style blocks) are counted **once** in the
"dedup" column; "raw" counts every copy. "Protos" = distinct prototype dirs using the value at least once.
Only about 10% of the volume is a shared copy (raw vs dedup differ by 5-12% per value); the prototypes are
overwhelmingly independently written, with no tokens (the `_template` has none, `prototypes/CLAUDE.md` says
nothing about the ramp), so the numbers reflect real authoring habits.

## A. App code

### A1. Ramp usage (class + Stack gap + Inset pad, combined)

| step | px | classes | Stack gap | Inset pad | total |
| --- | --- | --- | --- | --- | --- |
| none | 0 | 27 | 258 | 0 | 285 |
| 2xs | 2 | 192 | 268 | 1 | 461 |
| xs | 4 | 460 | 355 | 3 | 818 |
| sm | 8 | 511 | 469 | 25 | 1005 |
| md | 12 | 259 | 188 | 25 | 472 |
| lg | 16 | 154 | 64 | 33 | 251 |
| xl | 24 | 45 | 37 | 5 | 87 |
| 2xl | 32 | 31 | 7 | 1 | 39 |

The app lives at 4 and 8. Classes appear in 126-268 distinct files for 2xs/xs/sm, 96-157 for lg/md, 24-27 for xl/2xl.

### A2. Escapes (what the ramp could not express)

Total sites found: **262** (raw numeric + arbitrary, spacing only), of which about 200 sit under a
`spacing/no-adhoc-spacing` disable (213 disable lines in all; 213 `layout/no-adhoc-layout` often on the same line;
13 `text/no-adhoc-typography`, 7 `radius/no-adhoc-radius`).

By kind: **203 margin**, 48 padding, 8 gap, 3 space-between. The dominant escape is therefore "the ramp has no
margin", not "the ramp is too coarse".

| px | margin | padding | gap | total | files | note |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 9 | 0 | 0 | 9 | 7 | |
| 2 | 19 | 6 | 0 | 25 | 19 | on-ramp value, off-ramp class (margin) |
| 3 | 0 | 1 | 1 | 2 | 2 | |
| 4 | 46 | 6 | 0 | 53 | 40 | on-ramp value (margin) |
| 5 | 0 | 2 | 1 | 3 | 3 | `p-[5px]`, `py-[5px]`, `gap-[5px]` (desktop shelf, canvas) |
| **6** | 23 | 8 | 3 | **34** | 23 | `mr-1.5`, `mt-1.5`, `mx-1.5`, `gap-[6px]` ... |
| 7 | 0 | 2 | 1 | 3 | 2 | `py-[7px]`, `gap-[7px]` (shelf, canvas) |
| 8 | 86 | 8 | 0 | 95 | 64 | on-ramp value (margin) |
| 9 | 0 | 1 | 0 | 1 | 1 | |
| **10** | 0 | 6 | 2 | **8** | 4 | `px-[10px]`, `pt-[10px]`, `gap-[10px]` (prototypes/canvas x6, desktop shelf, file-explorer) |
| 12 | 2 | 1 | 0 | 4 | 3 | |
| 14 | 1 | 0 | 0 | 1 | 1 | `mx-3.5` in ui-kit sidebar |
| 16 | 12 | 1 | 0 | 13 | 9 | |
| 18/20/24/28/32/40/64 | 8 | 4 | 0 | 12 | ~10 | |

Off-ramp values that are NOT margin: 5, 6, 7, 9, 10, 14 appear in about 30 padding/gap sites, concentrated in
three hand-built surfaces (`apps/prototypes/canvas`, `apps/desktop/shelf`, `apps/home/new-app`). Real feature
code almost never needs 5/7/9/10/14. **6px** is the one off-ramp value that recurs across unrelated plugins
(reorder/editor, broadcasts, worktree-cleanup, code-review, plugin-changes, jsonl-viewer, op-status, workflow):
23 files, almost all margins as `1.5`. **10px: 4 files, 8 sites.**

Raw CSS in plugins (74 files, mostly illustration cards for the website, mermaid, hints): padding 10px x32,
8 x25, 6 x19, 4 x13, 5 x13, 9 x13, 7 x11, 14 x13; gap 4 x19, 8 x25, 6 x16, 5 x15, 7 x7. The off-ramp-heavy files
are `website/.../foundations/*.css` (cards that mimic app UI, 15+12+8+8+7+6+5...), `mermaid/*.css` (13) and
`hints.css` (11). These are the only places outside prototypes that copy mockup px verbatim.

Type escapes: arbitrary `text-[Npx]` is down to **7 sites** (`7px`, `9px` in sonata piano keys, `10.5px` in the
desktop wallpaper attribution, `12px`, `10px`), because the sub-scale exists: `text-2xs` is used at **66** sites
and `text-3xs` at **84**. Tailwind `text-xs/sm/xl/2xl` survive at about 15 sites.

Icon / square sizes (not spacing, `size-N`): `size-4` 225, `size-3.5` 162, `size-3` 93, `size-5` 53, `size-6` 24,
`size-2.5` 20 (the glyph sizes); odd `size-[18px]` x5, `size-[15px]` x2, `size-[7px]` x2.

Round (`rounded-full` + `size-*`) in app code: 20px x12, 24px x12 (most are dots and badges, not avatars),
8px x9, 10px x9, 22px x1, 28px x1, 32px x1, 34px x1. Nothing in app code asks for 22 or 28 as an avatar.

### A3. Theme and density tokens that are off-ramp

Mist leaves the ramp at defaults (no `--space-*` override) and instead pins **component tokens** to px values. This
is how the app already reaches mockup pixel values.

| token | Mist value (px) | token | other themes (px) |
| --- | --- | --- | --- |
| controlHeightXs/Sm/Md | 25 / 26 / 29 | controlHeightSm | browser 30, prototypes 30, sonata 32, menu-bar 22, equin-gallery 34.9 |
| controlPadXs / Sm / Md | 10 / 7 / 14 | controlPadXs | prototypes-option-rows 9 |
| padThreadCardX / Y | 13 / 10 | padRowX | menu-bar 10, prototypes-option-rows 10, rows 10 |
| padComposer | `10 13 9` | padRowY | files 5, menu-bar 6, option-rows 6, version-rows 8, document 6 |
| padChipHeaderX / Y | 11 / 4 | padChipX / Y | document 6 / 2, gallery 7 / 2 |
| padToolBadgeX / Y | 9 / 3 | controlIconXs/Sm/Md | mist 12 / 13 / 13, browser 15 / 16, prototypes 14 / 15 |
| padCodeX / Y | 6 / 1.5 | statusDotMd | 7 |
| padChipCompactX / Y | 4 / 1 | fontSizeBody | mist 13.5, pages-ink 13.5, others 13 |
| font-size Group | 12.5 | fontSizeGroup | files 11, pages-ink 11.5 |
| Tag / TagCompact | 11.5 / 10.5 | fontSizeCaption | sonata 11.5, menu-bar 11.5, pages-ink 12.5 |

Themes also retune the ramp itself, off the t-shirt default:

| theme | 2xs / xs / sm / md / lg / xl / 2xl (px) |
| --- | --- |
| comfortable (default) | 2 / 4 / 8 / 12 / 16 / 24 / 32 |
| cozy | 2 / 3 / 6 / 10 / 14 / 20 / 28 |
| compact | 1 / 2 / 4 / 8 / 12 / 16 / 24 |
| menu-bar | 2 / 4 / **6** / 8 / **10** / 12 / 16 |
| website shell | 2 / 4 / 10 / 14 / 20 / 24 / 28 |
| equin-document | 2 / 4 / 10 / 14 / 20 / 24 / 28 |
| equin-gallery | n/a / 8 / 12 / 14 / 16 / n/a / n/a |

So 6 and 10 are already reachable today, only by remapping `sm` and `md`/`lg`. The cozy preset puts `sm` = 6 and
`md` = 10. `menu-bar` shows the cost of that route: to get 6 and 10 it moves every step, so it can no longer have
8 in the same rhythm as 6.

## B. Prototypes

132 prototypes + template. Counts are per CSS declaration (values; shorthand split per side). Columns:
raw (all copies), dedup (shared sheets once), protos (distinct prototypes using the value).

### B1. Padding per side (12,115 values dedup)

| px | raw | dedup | protos | | px | raw | dedup | protos |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 328 | 314 | 78 | | 14 | 871 | 789 | 104 |
| 2 | 694 | 612 | 102 | | 16 | 660 | 630 | 106 |
| 3 | 594 | 518 | 78 | | 18 | 303 | 291 | 68 |
| 4 | 1100 | 941 | 108 | | 20 | 265 | 247 | 68 |
| 5 | 670 | 535 | 89 | | 22 | 58 | 58 | 25 |
| **6** | 1277 | 1138 | 118 | | 24 | 219 | 213 | 64 |
| 7 | 584 | 483 | 88 | | 26 | 72 | 72 | 19 |
| 8 | 1704 | 1530 | 117 | | 28 | 116 | 116 | 43 |
| 9 | 582 | 485 | 83 | | 30 | 30 | 26 | 17 |
| **10** | 1488 | 1359 | 120 | | 32 | 67 | 55 | 31 |
| 11 | 205 | 175 | 56 | | 40 | 75 | 73 | 44 |
| 12 | 1094 | 1016 | 118 | | 48 | 34 | 33 | 22 |
| 13 | 201 | 141 | 30 | | 64 | 34 | 34 | 26 |

### B2. Gap (3,247 values dedup)

| px | dedup | protos | | px | dedup | protos |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 41 | 35 | | 10 | 379 | 106 |
| 2 | 235 | 91 | | 11 | 19 | 16 |
| 3 | 90 | 44 | | 12 | 211 | 96 |
| 4 | 299 | 91 | | 13 | 15 | 14 |
| 5 | 146 | 58 | | 14 | 127 | 67 |
| **6** | 674 | 115 | | 16 | 65 | 39 |
| 7 | 149 | 56 | | 18 | 31 | 26 |
| 8 | 573 | 119 | | 20-24 | 41 | ~20 |
| 9 | 74 | 36 | | 26+ | ~60 | ~25 |

### B3. Margin per side (2,440 values dedup)

2 x266 (82 protos), 4 x408 (99), 6 x363 (103), 8 x314 (92), 10 x199 (72), 12 x120 (62), 14 x105 (54),
16 x75 (35), 3 x104 (51), 5 x78 (34), 1 x74 (48); half pixels and sub-pixels are rare (about 20 total).

### B4. Coverage: share of values a candidate ramp would land exactly

Existing ramp = 2, 4, 8, 12, 16, 24, 32 (dedup counts; 1px hairlines excluded from "ramp").

| ramp | gap | padding side | margin side |
| --- | --- | --- | --- |
| today (2,4,8,12,16,24,32) | 43.1% | 41.2% | 50.0% |
| + 6, 10 | **75.5%** | **61.9%** | **73.0%** |
| + 6, 10, 14 | 79.4% | 68.4% | 77.3% |
| + 6, 10, 14, 20 | 80.0% | 70.4% | 78.9% |
| + 6, 10, 5, 7, 9 | 86.8% | 74.3% | 78.4% |

Marginal value per added step (padding side, share of all values): 6 = 9.4%, 10 = 11.2%, 14 = 6.5%,
5 = 4.4%, 7 = 4.0%, 9 = 4.0%, 20 = 2.0%. In gap: 6 = 20.8%, 10 = 11.7%, 14 = 3.9%, 5/7/9 = 4.5/4.6/2.3%.
Adding 6 and 10 moves coverage by +32 points (gap), +21 (padding), +23 (margin). Everything after those two is
at most +6.5 points per step: the tail is a continuum (every integer 1-14 is used by 30-120 prototypes), which no
finite ramp covers.

### B5. Font size (4,295 values, dedup)

| px | dedup | protos | | px | dedup | protos |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | 21 | 15 | | 14 | 231 | 67 |
| 9.5 | 37 | 20 | | 14.5 | 30 | 17 |
| 10 | 116 | 51 | | 15 | 172 | 74 |
| 10.5 | 156 | 48 | | 15.5 | 39 | 18 |
| **11** | **523** | **105** | | 16 | 125 | 55 |
| 11.5 | 408 | 75 | | 17 | 82 | 40 |
| **12** | **978** | **118** | | 18 | 81 | 39 |
| 12.5 | 456 | 71 | | 19 | 34 | 21 |
| **13** | **437** | **98** | | 20 | 64 | 37 |
| 13.5 | 117 | 45 | | 22 / 24 | 40 / 22 | 25 / 16 |

Half-pixel sizes (9.5, 10.5, 11.5, 12.5, 13.5, ...) are 27% of all font-size values. 11px is the second most used
size in the whole set (523 values, 105 of 133 prototypes) and **already exists as `text-2xs`** (10px as
`text-3xs`; 12 = caption, 13 = label, 14 = body). 53% of prototype font-size values land exactly on
10/11/12/13/14; 61% with 16-24 added.

### B6. Round elements (width = height, border-radius 50%): 429 elements

| px | n | protos | | px | n | protos |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | 47 | 26 | | 24 | 13 | 13 |
| 7 | 50 | 33 | | 26 | 12 | 8 |
| 8 | 36 | 32 | | 28 | 12 | 8 |
| 12 | 30 | 22 | | 30 | 13 | 10 |
| 14 | 31 | 21 | | 32 | 14 | 12 |
| 16 | 15 | 13 | | 34 | **21** | 17 |
| 18 | 25 | 18 | | 36 / 38 / 40 | 6 / 7 / 8 | 6 / 6 / 5 |
| 20 | 20 | 14 | | 48 | 2 | 2 |
| 22 | 15 | 14 | | | | |

(6-14px are dots and indicators, not avatars.) Avatar-like (>= 16px): 16 x15, 18 x25, 20 x20, 22 x15, 24 x13, 26 x12,
28 x12, 30 x13, 32 x14, **34 x21**, 36-40 x21. There is **no avatar size** that clusters: 22 and 28 are 5th and 9th of
a 12-way spread, and 34 beats both. Only 24 and 32 (on the scale) and 16 (on the scale) are in the set at all, and
the scale's four sizes (16/24/32/48) account for 44 of 429 round elements (10%).

### B7. Shared-sheet caveat

`mist.css` (4+2 copies, 3 hashes), `home.css` x2, `agent-icons.html` style x4 and a few `index.html` style
blocks are copied across prototypes; 5-12% of the raw volume. Dedup and raw columns agree on every ranking and
on every recommendation below, so the conclusions do not depend on the copies.

## C. References (from memory, not verified)

| system | small-end handling |
| --- | --- |
| Tailwind | 4px base unit; 0.5 (2px) step to 12px, then 1.5 (6px), 2.5 (10px), 3.5 (14px) exist; plus 1, 2, 3, 4 ... Half steps only to 3.5, whole steps after 4. Type: `text-xs` 12, `sm` 14, `base` 16 (no 11 or 13 in the default scale, hence everyone's `text-[11px]`). |
| Radix Themes | Space 1-9: 4, 8, 12, 16, 24, 32, 40, 48, 64. No 6 or 10; 12 is the finest step above 8. Type 1-9: 12, 14, 16, 18, 20, 24, 28, 35, 60. |
| GitHub Primer | `--base-size-4/8/12/16/20/24/32/40...` plus 2, 6 as small named sizes; Primer type has a 12px caption, 14px body, with 11 used for labels/counters. Denser than Radix at 6. |
| Linear | Dense app, 4px grid in spirit, but UI text at 11, 12, 13 (13 is the base) with 11 for meta; sizes are named tokens (`--font-size-micro`, `small`, `regular`). |
| Apple HIG / macOS | Sidebar rows 24-28 high (small/medium/large sidebar: 24/28/32 at default), icon 15-17 in them, 11pt for control size "mini/small" text and 13pt body. Row paddings 4/6/8; avatars in lists are 22-28 (Messages/Mail 28). |

Takeaway: dense pro apps treat 6 as an ordinary step (Tailwind, Primer, macOS), 10 is usually reachable via
Tailwind 2.5, and 11px meta text is a named token everywhere dense (Linear, macOS small). Nobody ships a 22/28
avatar ramp; list avatars are a themeable component size.

## Findings

1. **6px is the one clearly missing spacing step.** It is the single most used off-ramp value in prototypes
   (padding 1138, gap 674, 118 and 115 of 133 prototypes), the one off-ramp value that recurs across unrelated app
   plugins (34 sites, 23 files), already present in the cozy preset (`sm` = 6) and in menu-bar's retuned ramp, and
   already the value of `padRowY`, `controlGap`, `padChipX` tokens.
2. **10px is the second.** padding 1359 (120 of 133 prototypes), gap 379 (106), the largest single value in prototypes
   after 8. App code needs it rarely (8 sites, 4 files, all hand-built surfaces), but Mist/menu-bar component
   tokens use it (controlPadXs 10, padRowX 10, padComposer 10) and the cozy preset's `md` is 10.
3. **Beyond 6 and 10 there is no cluster.** 14 (6.5% of padding) is third, then 5/7/9 at 4% each, and the tail is
   a flat continuum used by 30-120 prototypes per integer. Coverage of exact values: 41% today, 62-76% with 6+10,
   68-79% with 14 added, 74-87% with 5/7/9 added (diminishing: each further step costs 14 more utilities for 2-6 points).
4. **The app's main escape is margins, not step coarseness.** 203 of 262 raw escape sites are margins (`mt-1.5`,
   `mb-2`, `ml-1.5`), including 19 + 46 + 86 sites whose value IS on the ramp (2/4/8). Adding steps does not
   remove those; margin classes (or restructuring into Stack gaps) would, a different decision.
5. **An 11px meta size already exists** (`text-2xs` = 0.6875rem, `text-3xs` = 10px, `text-caption-compact` = 2xs).
   It is used 66 + 84 times. 11px is the second most common prototype size (523 values, 105 prototypes). What
   prototypes show that the scale lacks is **half-pixel sizes** (27% of values: 10.5, 11.5, 12.5, 13.5), but those
   are exactly the per-theme role tunings Mist, sonata and menu-bar already make (Mist: group 12.5, tag 11.5,
   tag-compact 10.5, body 13.5; sonata: label 12.5, caption 11.5; menu-bar: caption 11.5, 2xs 10.5). They belong in
   the theme, not the scale.
6. **Avatar sizes are a continuum, so 22/28 would not buy pixel-perfection.** Prototype avatar-like circles spread
   over 16-40 with no mode (22 x15, 28 x12, 34 x21, 18 x25, 20 x20, 30 x13). App code never asks for 22 or 28. But
   the avatar box is the only control-shaped size that a theme cannot retune (hard-coded `size-4/6/8/12`), unlike
   control heights, icons, chips and status dots which are all density tokens.
7. **Pixel-perfect today already goes through component tokens, not the ramp** (Mist sets about 20 off-ramp
   component tokens: heights 25/26/29, pads 13/10/9/11, etc.). The ramp is for layout rhythm. A ramp that matches
   every mockup value is neither achievable nor the intended mechanism.

## Recommendation

**Add two ramp steps. Refuse the rest.**

### Add

| name | comfortable | between | purpose |
| --- | --- | --- | --- |
| `xsm` | 6px (0.375rem) | `xs` (4) and `sm` (8) | the small-end rhythm: icon-to-label insets, tight rows, 6px chip/row padding |
| `smd` | 10px (0.625rem) | `sm` (8) and `md` (12) | control and row side padding, composer paddings |

- Existing names are untouched: they slot in as in-between names, ordered `none < 2xs < xs < xsm < sm < smd < md <
  lg < xl < 2xl`. The ramp stays closed (10 steps). Naming is a bikeshed point: a hyphenated name
  (`xs-sm`) is avoided because the step is parsed after family names such as `gap-x-`/`gap-y-`; a letters-only name
  keeps `gap-xsm` unambiguous. The `dead-spacing` lint and the `@ramp steps:` declaration pick it up as usual.
- Mechanics (from `space-ramp/CLAUDE.md`, "To add or rename a step"): add the `@utility` to all 14 families in
  app.css (28 new utilities), add `--space-xsm` and `--space-smd` to the density token group, update
  `/* @ramp steps: */`, `./equin build`. `Stack gap` / `Inset pad` unions widen via `SPACE_STEPS`.
- Cost to consumers: none (additive); the diff to existing prototypes' coverage is +32 / +21 / +23 points.

### Density presets

Do not hand-write three more preset values; **derive each new step from its neighbours**, so it follows
presets and any theme's retuning:
`--space-xsm` default `calc((var(--space-xs) + var(--space-sm)) / 2)`,
`--space-smd` default `calc((var(--space-sm) + var(--space-md)) / 2)` (the density group already has precedent:
`padRowCompactY: calc(var(--pad-row-y) / 3)`, `documentPadTop: var(--space-md)`). That yields:

| preset | xsm | smd |
| --- | --- | --- |
| comfortable | 6 | 10 |
| cozy | 4.5 | 8 |
| compact | 3 | 6 |

A midpoint can never cross its neighbours, so the order invariant holds under any retune. A theme that wants
exact values (menu-bar, whose ramp is 4/6/8/10/12, or Mist if it ever wants `xsm`=6 exactly regardless of preset)
sets them like any other step. Add the two keys to the three presets in `shortcuts.ts` only if exact preset
values are wanted (the derived values give the 4.5 and 3 px fractional results above; if fractional pixels are
disliked, give cozy 4 / 8 and compact 3 / 6 explicitly).

### Refuse

- **5, 7, 9 px**: 4% each, no cluster; snap to 4 / 8 (5, 7, 9 round to xs/xsm/sm/smd as below) or express as a
  Mist-style component token.
- **14 px**: 6.5% of padding, 3.9% of gap; borderline. Defer: revisit once `xsm`/`smd` exist and prototypes are
  re-measured; if it still shows, `mdl` (14) is the next candidate. Until then 14 snaps to `md` (12) or `lg` (16).
- **20, 22, 26, 28, 30+**: scattered; `xl` (24) and `lg` (16) cover them.
- **An 11px text step**: it exists (`text-2xs`). Do nothing but document it in the prototype guide (below).
- **Half-pixel text sizes** as steps: these are theme role tunings (A3), not scale steps.
- **22/28px avatar steps**: no cluster (B6), no app demand (A2). Do the structural thing instead, below.

### Snap (prototype value -> ramp), to put in `prototypes/CLAUDE.md`

| prototype px | use | prototype px | use |
| --- | --- | --- | --- |
| 1 | hairline (border), not spacing | 10 | `smd` |
| 2 | `2xs` | 11, 12 | `md` (12) |
| 3 | `2xs` (2) or `xs` (4), by context | 13 | `md` |
| 4 | `xs` | 14, 15, 16 | `lg` (16) (14 defers, see above) |
| 5 | `xs` (4) when tight, `xsm` (6) when padded | 18, 20 | `lg` or `xl` |
| 6 | `xsm` | 22-26 | `xl` |
| 7 | `xsm` (6) or `sm` (8) | 28-32 | `2xl` |
| 8 | `sm` | 40+ | layout, not spacing |
| 9 | `sm` (8) or `smd` (10) | | |

Text: 9-10.5 -> `text-3xs` (10); 11-11.5 -> `text-2xs` (11); 12-12.5 -> caption; 13-13.5 -> label;
14-14.5 -> body; 15-15.5 -> subheading or body; 17-19 -> heading; 20-22 -> title. A prototype that depends on a
half-pixel role (12.5, 11.5) should name the theme role it is tuning, not carry the number.

### Do instead of avatar steps

Make the avatar a themeable size like every other control-shaped box: move `SIZE_MAP.box`/`icon`/`dot` to density
tokens (`avatarXs..Lg`, defaults 16/24/32/48 and the current glyph shares), so a Mist-like theme sets 22/28/34
without new steps or renames and the default stays pixel-identical. This is the same mechanism that already lets
Mist set `controlHeightMd` = 29. It is a separate, small change, and it removes the "avatar size cannot match the
mockup" blocker for any size, not just 22 and 28.

### Also worth a decision (outside the question)

Margins: 203 of 262 escape sites are margins with no ramp class (A2). A ramp margin family (`mt-sm`...) or a
sanctioned "stack with a different gap" pattern would clear most of the 213 inline disables regardless of which
steps are added.
