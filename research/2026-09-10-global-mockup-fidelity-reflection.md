# Mockup fidelity: what an agent can match, what the abstractions block, and the missing comparison tool

## Context

The Prototypes app puts a mock beside the real screen (the Compare stage), and
the equin website was built from the `proto-1788797350-gqju` Launch mock
(azure palette). Side by side they looked nothing alike: the mock took 1715px
of height at 1280 wide, the site 1002px; every type rung was 20 to 40 percent
smaller; the palette was Ocean rather than the mock's near-black; the cards were
flatter and tighter.

Two questions were asked:

1. Can an agent produce a pixel-faithful replica of a mock (content aside)
   through the codebase's design abstractions, and where do those abstractions
   get in the way?
2. Is eyeballing the Compare stage enough, or is a comparison tool missing?

This document records the experiment and what it says about both.

## Method

1. **Baseline measurement.** A throwaway Playwright script (`design-diff`)
   opened the mock and the deployed site at the same width in dark mode,
   extracted every innermost text-bearing element with its computed
   typography, colour and page-space box plus the nearest ancestor that paints
   a background or border, matched mock and app elements by their text, and
   printed a per-property delta table. It also wrote a side-by-side PNG and a
   pixel-diff PNG with a mismatch ratio over the shared height.
2. **A Fable agent** was given the mock as the spec and the website plugin tree
   as the deliverable, with the repo rules in force: take the cleanest
   mechanism at each layer, do not pile up escape hatches, record every
   property it could not match and which abstraction blocked it.
3. **Build, measure, feed back.** The orchestrator built the worktree, ran the
   same measurement against the result, and sent the agent the measured deltas
   for a second pass.

The agent was never allowed to see the deployed result itself. Every visual
fact it learned after writing code came from the measurement tool. That was a
deliberate choice: it isolates "can the agent reason its way to fidelity from
the spec" from "can the agent converge given a numeric oracle".

## Results

| Measure at 1280px, dark | Before | After round 1 | After round 2 |
| --- | --- | --- | --- |
| Pixel mismatch over shared height | 15.8% | 9.1% | 5.9% |
| Page height (mock 1715px) | 1002px | 1668px | 1748px |
| Headline size (mock 78px) | 48px | 78px | 78px |
| Headline lines (mock 3) | 2 | 2 | 3 |
| Card padding (mock 34px) | 12px | 34px | 34px |
| Card radius (mock 20px) | 16.8px | 20px | 20px |
| Header height (mock 72px) | 40px | 72px | 72px |
| Computed font (mock Inter) | system stack | system stack | Inter Variable |

Round 1 closed the large gaps: type scale, palette, card chrome, header height,
band rhythm and the hero glow all measured correct. Round 2 addressed the one
systematic leftover the agent could not have found from git alone (the font,
below); with it the hero matches to the pixel and the headline wraps like the
mock. The remaining 5.9% is made of the items in the agent's blocked table (a
1px size step on three rungs, button padding and radius, a third grey, the
header hairline and nav gap) plus the differing fork-card copy, which was out
of scope by design.

## Where the agent succeeded, and through which mechanism

The agent did not fight the abstractions; it used them the way they were meant
to be used, and got most of the way:

- **The site owns its theme as one preset per token group.** The website shell
  contributes an `equin` preset to colour palette, chart, type scale, density
  and shape, each pinned per app under `config/ui/tokens/<group>/@app/website/`.
  Components read semantic tokens and `Text` roles only. This is the intended
  path and it worked end to end.
- **A named band rhythm instead of stacked ramp steps.** The page's vertical
  score (120/88, 96, 48, 64/80, 28/40px) sits above the spacing ramp's 2rem
  ceiling. Rather than stacking ramp steps, `WebsiteBand` takes a `rhythm`
  role whose padding is declared once in the shell's CSS. A new band picks a
  role and never writes a number.
- **The header's 72px and its alignment to the 1040px measure** came from
  density tokens (`chromePaneH`, and `chromePadX` computed from the site's
  measure variable), not from overriding the pane chrome.
- **The hero glow** was placed with the coords primitive at the mock's exact
  tile geometry and painted from tokens.

## Where it failed, and why

Each failure is a different kind of wall. They matter more than the pixel
count because they are the things every future mock-to-app agent will hit.

### 1. Runtime state that git cannot show

The deployed site rendered in the system font even after round 1. The agent's
report said "the default font preset is Inter Variable, no pin needed", which
is true of the committed config. But the desktop's font-family config carries a
runtime user override (`preset: "tweakcn:claude"`, a system-font stack) that
lives in `~/.singularity/state/config/` and is replicated into every worktree.
The website pinned five token groups and not the sixth, so the sixth followed
the desktop.

Two structural points:

- **Per-app theme ownership is per token group, and the failure mode of a
  missing pin is silent inheritance.** A site that "owns its colour" is one
  runtime override away from not owning its font. The fix that removes the
  class of bug is a single declaration, "this app owns its whole theme", that
  either pins every group or fails loudly when one is unpinned.
- **An agent working from the checkout cannot see runtime config.** The
  committed origin says one thing, the effective value another. The
  measurement tool caught it in one run; nothing in the code path would have.

### 2. Closed sets with no rung of the right size

The type scale has seven roles; the mock has eleven distinct sizes. Wordmark
22px became 24px (`heading`), the story line 18px became 19px (`subheading`),
the email 13px became 12px (`caption`). Tracking is hardcoded per role in the
ui-kit CSS with no token behind it, so the display's −0.045em became
−0.05em (`tracking-tighter`), which together with the system font collapsed
the headline from three lines to two and shifted every band below it by 50 to
80px. The palette has one muted tier; the mock has three greys.

These are not bugs in the abstractions. They are the abstractions doing their
job (a closed set keeps the app coherent) against a spec that was drawn without
them. The question is whether the marketing site is the kind of surface that
should be held to the app's closed sets at all (see below).

### 3. A ramp sized for chrome

The spacing ramp tops out at 2rem. The agent retuned the ramp per app through
the density preset (so `lg` is 20px on the site, the gap between two cards) and
still needed a second, document-scale rhythm for the bands. It put that rhythm
in a CSS file rather than a token, because there was nowhere to put it. A
section-rhythm ramp (or `3xl` to `6xl` steps) would make it a token.

### 4. Primitives that carry their own metrics

- `Button` hardcodes horizontal padding and icon gap per size and ignores the
  density group's `padControlX`. So a density preset can set a control's height
  (38.4 and 44.4px measured exact) but not its width: the mock's 18px padding
  measured 10px, the CTA 116px wide instead of 133.
- `Card` has one padding token for all four sides; the mock's fork cards are
  34/34/38/34.
- The shape scale fixes the card-to-button radius ratio at 1.8:1; the mock has
  20px cards and 10px buttons (2:1). The agent chose to make the cards exact.
- The pane header `Bar` always paints a bottom hairline and cannot be told not
  to; the mock's header has none.

### 5. The header is chrome, not document

The mock's header scrolls with the page and the hero glow tints it. The site's
header is the pane header, fixed above the scroller, so the glow starts below
it and is clipped at the top. Matching this needs a pane option to render its
header in-document, which is a real change to the pane primitive.

## The abstraction gaps, ranked

Rung on the fix ladder in parentheses.

1. **Whole-theme ownership per app** (type or check). One declaration that
   pins every token group for an app, or a check that fails when an app pins
   some groups and not others. Removes the silent-inheritance class entirely.
2. **Tracking tokens in the type-scale group** (inexpressible → token). Move
   letter-spacing per role from hardcoded CSS to `--tracking-<role>` tokens so
   a preset can theme it. Cheap, and the headline wrap bug was caused by it.
3. **A document-scale rhythm** (token). Either extend the ramp or add a
   separate section-rhythm group the band primitive reads. Today it is a CSS
   file only the website knows about.
4. **Button reads density padding** (token). `padControlX/Y` exist and are
   ignored. Make the cva read them so a density preset owns width rhythm too.
   *Done: per-size `controlPad*` / `controlGap*` tokens replace them — see
   `2026-09-15-global-button-density-padding.md`.* *A pill adds the shape group's
   `pillPadExtra` on its rounded ends — see
   `2026-09-15-global-pill-button-padding.md`.*
5. **A third text tone / muted tier** (token + closed union). `subtle` tone
   backed by a `muted-foreground-subtle` token.
6. **A header-less or in-document pane header option** (primitive). Needed
   only by surfaces that are documents rather than chrome; the website is the
   first.
7. **Per-side card padding, a 2:1 radius rung, a `3xl` step** (nice to have;
   each is one measured pixel row, not a class of bug).

A different framing is worth deciding on first: **is a marketing page an app
surface?** The closed sets exist so that app chrome across forty plugins stays
coherent. A designed one-off page is the opposite case: one author, one
palette, one type scale, no reuse. If the answer is "a website is a document,
not chrome", then the right move is not to widen every closed set until it fits
this page, but to let a document-class app declare its own scale (roles, ramp,
tracking) as data in its shell, with the same primitives reading that scale.
The agent's `website-band.css` and its `equin` presets are already most of the
way to that shape.

## Eyeballing versus measuring: the missing tool

The Compare stage answers "do these look alike?" to a human. It does not
answer "what, specifically, is different, by how much, and which rule caused
it?" to an agent. Everything decisive in this experiment came from the
measurement, not from looking:

- The font finding was invisible in a side-by-side (Inter and the system font
  look alike at a glance) and obvious in one table row.
- The headline wrapping to two lines read as "the hero feels short" to the eye
  and as "lede y −79px, tracking −3.9 vs −3.51px" to the tool, which is
  actionable.
- The mismatch ratio gave a number to converge on across rounds.

What the tool does today (a throwaway under `test-results/`, not committed):

- Same width, same colour scheme, both pages fully rendered.
- Element extraction: innermost text-bearing elements, matched by normalised
  text (content is the same, so text is a stable key), with font size, weight,
  tracking, leading, colour (normalised to rgb so oklch and rgb spellings
  compare), family, and page-space box; plus the nearest ancestor that paints a
  background or border, with its background, border, radius and padding.
- A per-property delta table and a pixel diff with a mismatch ratio.

What it should become, and where it should live:

- **Home:** the Prototypes app's Compare stage already owns "mock beside the
  real thing at one shared width". The measurement is the same pairing with
  numbers instead of eyes. As a `./equin` verb (`prototype diff <id>`)
  it resolves the mock and its declared `mocks:` counterpart itself, so an
  agent never hand-writes a URL. The e2e harness already has the pieces
  (target resolution, `withBrowser`, `samplePixels`).
- **Output for agents:** the delta table, sorted by magnitude, with each row
  naming the property, the mock value, the app value, and where possible the
  token or role that produced the app value (the computed style tells you the
  font-size; the token group tells you it came from `fontSizeHeading`). That
  last column is what turns a measurement into a fix.
- **Output for humans:** the side-by-side and diff PNGs surfaced in the Compare
  stage, with the table beneath.
- **Convergence loop:** an agent that can run the diff after each build does
  not need a human to eyeball at all. In this experiment the orchestrator was
  that loop; it should be the agent's own.

## Done in the same session, after the experiment

- **Whole-theme ownership as a check.** `tokens:app-theme-pins-total`
  (`plugins/ui/plugins/tokens/check/`) fails when an app pins some token
  groups and not others; the group set is read from the committed base
  origins. The website now pins all eleven groups, the five it has no opinion
  about explicitly to `default`. A check is the highest rung that can see
  files; the rung above (one total declaration per theme) is blocked by
  `GlobalPreset.groups` being a partial, string-keyed record, which is the same
  partiality one level up and the natural next step.
- **`Surface as="button"` no longer centres.** The two fork cards shipped with
  their eyebrows on different baselines: the grid stretched both cards to one
  height and a `<button>` centres its content by UA rule, so the shorter
  column sank. Surface already owned the box for `as="a"` (inline fragments);
  it now emits a top-packed, left-aligned flex column for `as="button"`, with a
  jsdom test. Measured: both eyebrows at one y, the fork heading 2px from the
  mock where it was 24px off. Final mismatch 5.7%.

## Open questions

- Is the website an app surface (hold it to the closed sets, widen them where
  a class of bug appears) or a document (let it declare its own scale)?
- Should whole-theme ownership be a check (fails on partial pins) or a type
  (one declaration expands to every group)?
- Does the design-diff tool belong to the Prototypes app (mock-centric) or to
  the e2e harness (any two URLs)? The pairing logic says Prototypes; the
  mechanics say harness. Probably a harness helper the Prototypes verb calls.
