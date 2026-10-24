# Pill buttons get their own extra side padding, from the shape group

## Context

A theme sets a button's side padding per size (the density group's
`controlPad*` tokens, see `2026-09-15-global-button-density-padding.md`). But a
pill button (`shape="pill"`) and a rectangular or ghost button of the same size
always get the same padding.

The equin website's Launch mock (`proto-1788797350-gqju`) needs two different
values at the same small size:

- the header's Improve pill has **18px** side padding;
- the quiet nav links beside it (ghost buttons) have about **12px**.

At 18px the pill matches the mock to within 1px, but the nav words sit ~42px
apart against the mock's ~29px. At 10–12px the nav matches and the pill is too
narrow. No single density value fits both.

A pill's rounded ends take up room that a rectangle's corners don't, so the
extra padding belongs to the shape, not to density.

**Decisions (user, 2026-09-15):**

- **One token in the Shape group**, "Pill extra padding". A pill's side padding
  is the size's normal control padding **plus** this amount. So pills follow
  density on their own: a Compact theme shrinks them along with everything else.
- **Default `0`.** The Default theme does not move. Only a theme that sets the
  token (the website) gets wider pills.

**Revised during implementation (2026-09-16).** The first version of this plan
had four extra `px-control-pill-<size>` classes, chosen per (size, shape) by the
Button's class table. Before building, the branch was rebased onto main, which
had just gained a **split pill** (`ButtonGroup shape="pill"`, used by the app
chrome's Improve and Build controls). Its two outer ends are rounded, its seams
are square, and some of its segments are icon-only. The group does not know its
children's size, so per-size pill classes could not reach it. Also, an extra
start padding on a fixed-width icon segment would push its icon off-centre. The
design below replaces those four classes with per-side variables that the size's
own padding reads. That handles all three shapes, and makes icon segments safe by
construction.

## Design

### 1. Token — `plugins/ui/plugins/tokens/plugins/shape/core/group.ts`

`pillPadExtra: { default: "0rem", label: "Pill extra padding" }` → CSS var
`--pill-pad-extra`. The customizer's Shape section lists every schema key, so the
row appears with no UI change. The four "Fill from…" shortcuts (whole-group value
sets) each set it to `0rem`.

### 2. Utilities — `ui-kit/web/theme/app.css`

- Two registered properties, `--pill-extra-start` / `--pill-extra-end`
  (`<length>`, `inherits: false`, initial `0px`). They mean "the extra this
  element's start / end side takes because that side is a rounded end".
  Non-inheriting, so the extra belongs to the element whose shape declared it,
  never to a control nested inside it.
- Each `px-control-<size>` now writes
  `padding-inline: calc(pad + var(--pill-extra-start)) calc(pad + var(--pill-extra-end))`.
  With both at 0 it computes exactly as before. It stays in tailwind-merge's
  `px` group, so a caller's `px-0` / `pl-*` still overrides it.
- Three declaration utilities (no padding of their own, `twmerge: standalone`):
  `pill-ends` sets both variables to `var(--pill-pad-extra)`; `pill-start` and
  `pill-end` set one each.

An element with no `px-control-*` (an icon-sized or inline button, a chip on
`p-chip`) ignores the variables, so declaring a rounded end on it does nothing.

### 3. Who declares a rounded end

- **Button** `shape="pill"` → `rounded-full! pill-ends`.
- **ButtonGroup** `shape="pill"` → its first segment gets `pill-start` and its last
  segment `pill-end` (plus the same selectors through `display:contents` slot
  boxes, beside the existing `rounded-l-full` / `rounded-r-full`).
- **Badge** `shape="pill"` → `rounded-full pill-ends`. This covers ToggleChip:
  its medium size uses `px-control-sm`, so a medium chip stays as wide as a pill
  button beside it with no change to ToggleChip itself.

### 4. Website — `apps/website/plugins/shell/web/internal/theme.ts`

In the `equinDocumentTheme` sub-theme:

- density: `controlPadSm: "0.75rem"`, the 12px of the quiet nav links;
- shape: `pillPadExtra: "0.375rem"`, 6px, so the Improve pill lands on 18px.

Nav spacing: 12 + 4 (`space-xs`) + 12 = 28px between nav words, against the
mock's ~29px. The other website buttons at the small size are `aspect="inline"`
(wordmark, story link) and have no side padding.

### 5. Tests

- `ui-kit/web/lib/utils.test.ts`: `pill-ends` survives a merge with
  `px-control-sm`, a caller's `px-0` still replaces the padding, and
  `pill-start` / `pill-end` compose with the rounded-end classes.
- `ui-kit/web/__tests__/button-pill.test.tsx` (jsdom): a pill Button carries
  `pill-ends` beside its `px-control-*`; a rectangular one carries no `pill-*`
  class; a pill ButtonGroup declares only its outer ends; a plain group declares
  none. jsdom evaluates no stylesheet, so the arithmetic itself is checked by
  `ui-kit/e2e/pill-padding-verify.ts`, which mounts probe elements in two live
  theme scopes — the app's (extra 0: a pill pads like a rectangle) and the
  website's document sub-theme (12px + 6px, and one side each for a split
  pill's end segments).

### 6. Docs

Theme skill (control-bundle paragraph), `ui-kit/CLAUDE.md` (ControlSize
paragraph), and a "done" line in `2026-09-15-global-button-density-padding.md`
(Out of scope) and in the reflection doc (gap #4).

## Out of scope

- **The "Pill" shape shortcut** (radius 9999px) makes every rectangular button
  look like a pill, but they are still `shape="default"`, so they don't get the
  extra. Making the extra follow the real corner radius would move every button
  in every theme.
- **Badge pills on the chip scale** (`p-chip`) don't read the variables, so a
  plain pill Badge pads as before.

## Verification

1. `./equin build` passes, including `css-vars-supplied`,
   `app-css-utilities-in-sync`, `token-group-vars-in-sync`, type-check and eslint.
2. `./equin test plugins/primitives/plugins/css/plugins/ui-kit`.
3. `./equin run plugins/primitives/plugins/css/plugins/ui-kit/e2e/pill-padding-verify.ts`
   — the padding relation in both theme scopes.
4. **Website.** `apps/website/plugins/shell/e2e/site-chrome-verify.ts` checks the
   pill's padding is 18px, a quiet nav link's is 12px, and the nav words sit
   26–31px apart. Then `compare-diff.ts --name proto-1788797350-gqju --width 1280`
   for the header cells.
5. `chrome-vs-mock.ts` (apps-core/chrome-theme) — the app chrome's split pill is
   unchanged.

## Outcome (2026-09-16)

- Build green (checks included); 114 ui-kit tests pass.
- `pill-padding-verify.ts`: 7/7. The app's theme reads a 0 extra and a pill pads
  exactly like a rectangle; the website reads 6px over its 12px small control,
  both ends on a pill and one side each on a split pill's end segments.
- `site-chrome-verify.ts`: 15/15 — the Improve pill measures 18px and 38.4px
  tall, a quiet nav link 12px, and the nav words sit the mock's ~29px apart
  (they were ~42px).
- `chrome-vs-mock.ts`: 19/19 on this build. Its first run failed one check
  (`the chrome keeps its ground on an app with its own theme`) on a cold
  backend: that step does `goto` + a fixed 4s wait rather than waiting for the
  element, so it reports a missing node as a colour mismatch. Passes on re-run
  and on main.
- Against the mock, `compare-diff` is 13.26% here vs 13.27% on main — the nav
  words are thin ink, so the fidelity gain barely registers in a pixel ratio.
  The measured 29px is the evidence.
