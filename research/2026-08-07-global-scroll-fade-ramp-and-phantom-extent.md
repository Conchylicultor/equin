# scroll-fade: a fade that reads as a fade, and a strip that adds no extent

## Context

`scroll-fade` (`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`) paints
the "there is more content this way" gradient at the edges of every `OverlayPanel`.
Two defects:

1. **It reads as a cutoff, not a fade.** The row under the strip is simply hidden
   rather than visibly dissolving. The gradient itself is meant to be perceptible.
2. **A menu whose content fits still paints a bottom fade.** Measured on the `/`
   menu filtered to one item: `clientHeight 44, scrollHeight 48` — exactly
   `--scroll-pad` of overflow that does not exist. `useScrollFade` believes it and
   arms `data-fade-bottom`, which is the always-on lie the whole mechanism exists
   to avoid.

Both were diagnosed by measurement, not inspection, on a standalone fixture that
reproduces the live numbers exactly (`clientHeight 44 / scrollHeight 48` on a
one-item `p-xs` panel).

### What the measurements settled

**The `box-shadow` is innocent.** With `box-shadow: none` the panel still measures
`44 / 48`. Shadows are ink overflow, as the spec says.

**`::before` is the whole of the 4px.** Deleting `::before` → phantom 0. Deleting
`::after` → phantom still 4. It cancels its flow contribution *forwards*
(`margin-bottom: -span`), so its border box sits at the content start and extends
`span` **down**, past the panel's end edge — and a border box counts toward the
scrollable overflow region whether or not a margin cancels its flow contribution.
The phantom is exactly `padTop + span − clientHeight`, which on the one-item menu
is `4 + 44 − 44 = 4`.

This is not a new discovery — `app.css` already names this failure mode in prose,
and `ui-kit/CLAUDE.md` already prescribes the fix ("each cancelled by an
equal-and-opposite **`margin-top`** so it hangs *backwards*"). Only `::after`
does it. The code drifted from its own documentation, and the CSS comment records
the reason it was reverted: `::before` hanging backwards supposedly "never paints
over the first rows".

**That reason does not reproduce.** With `::before` cancelling backwards
(`margin-top: -span`), sticky brings the strip back to the edge and the painted
coverage is identical to today at every offset, to within 1%. Phantom drops to 0
at every panel size.

**`max-height: 100%` is inert.** The panel's height is indefinite (auto with a
`max-height` cap), so the percentage computes to `none` — a variant with
`max-height: none` measures identically at every size. It was added to fix this
bug, does nothing, and its comment claims a mechanism that is not running.

**The two edges are already identical.** Sampled coverage down a column of a
scrolling panel, top vs bottom, agrees within 1% at every offset — they share one
mirrored `--scroll-fade-stops` list. The bottom is not stronger; it is simply the
one showing *at rest*, over content nobody has seen yet.

## The change

### 1. `::before` cancels backwards (`app.css`)

```css
&::before {
  top: 0;
  margin-top: calc(-1 * var(--scroll-fade-span));   /* was: margin-bottom */
  background: linear-gradient(to bottom, var(--scroll-fade-stops));
  box-shadow: 0 calc(-1 * var(--scroll-pad, 0px)) 0 0 var(--chrome-mask);
}
```

Both strips then hang backwards, so neither can ever reach past the panel's end
edge — start-direction overflow is not scrollable, so this is structural, not a
size that happens to fit. Drop `max-height: 100%` and its comment.

Keep the `box-shadow` padding-bleed: measured free, and still needed, because a
sticky box is confined to its containing block (the panel's **content** box) and
cannot be pushed out over the padding.

Rewrite the comment block accordingly: the two strips are now genuinely mirrors
(one shared `margin-top`), the `::before`-paints-nothing claim is removed as
unreproducible, and the `max-height` paragraph goes with it. `ui-kit/CLAUDE.md`
already describes this design and needs only the `max-height` mention checked.

### 2. A ramp with a shorter plateau and a longer decay (`app.css`)

One shared stop list, both directions substituting it, as today. Solid across the
host's padding plus a hairline, then a near-linear dissolve:

```css
--scroll-fade-stops:
  var(--chrome-mask) 0,
  var(--chrome-mask) calc(var(--scroll-pad, 0px) + var(--scroll-fade-h) * 0.06),
  color-mix(in oklab, var(--chrome-mask) 86%, transparent) calc(… * 0.2),
  color-mix(in oklab, var(--chrome-mask) 66%, transparent) calc(… * 0.36),
  color-mix(in oklab, var(--chrome-mask) 44%, transparent) calc(… * 0.52),
  color-mix(in oklab, var(--chrome-mask) 25%, transparent) calc(… * 0.68),
  color-mix(in oklab, var(--chrome-mask) 10%, transparent) calc(… * 0.84),
  transparent var(--scroll-fade-span);
```

`--scroll-fade-h` stays `2.5rem`; every stop stays `padding + <fraction of the
ramp>`, so the ramp is identical at every padding role. Measured coverage of the
panel background, by distance from the edge:

| distance | today | proposed |
| -------- | ----- | -------- |
| 0–11px   | 100%  | 100%     |
| 16px     | 100%  | ~85%     |
| 20px     | 89%   | 72%      |
| 24px     | 80%   | 59%      |
| 28px     | 65%   | 45%      |
| 32px     | 49%   | 33%      |
| 40px     | 18%   | 13%      |
| 47px     | 0%    | 0%       |

On a 36px row, today roughly two thirds of it is ≥80% masked — hence "cutoff".
Proposed, the whole row is visibly dissolving.

### 3. Close the verification gap (`e2e/scroll-fade-verify.ts` + harness)

The script asserts attributes and computed opacity but nothing about geometry, so
a strip that is opaque *and positioned outside the visible box* passes everything.
Two additions, both structural rather than per-symptom:

**a. The extent invariant, stated directly.** In `probe()`, measure `scrollHeight`,
remove the `scroll-fade` class, measure again, restore it, and report both. Then
assert equality in every state the script already visits (turn-into rest/mid/end,
`/` open, `/` filtered, Select):

```
r.eq("the fade adds no scrollable extent", p.scrollHeight, p.scrollHeightBare)
```

That is the invariant the whole utility rests on, and it cannot be satisfied by
luck — it would have failed on today's code at the `/`-filtered state, and on
every earlier attempt at this bug.

**b. Painted geometry, from pixels.** Add a sampling helper to the shared harness
(`e2e-harness/e2e/shots.ts`, exported from its barrel — the harness owns browser
mechanics, the plugin's script owns the domain assertions): screenshot, hand the
PNG back into the page as a data URL, decode it on a canvas, and read back a
region's pixels. No image dependency; the browser does the decoding.

With it, assert on the turn-into panel at mid-scroll, per edge:

- the panel's own edge row is entirely `--chrome-mask` — nothing shows through the
  padding, which is the unfaded-sliver bug the `--scroll-pad` offset exists for,
  *and* the "opaque but off-screen" bug that went uncaught;
- content becomes visible before the plateau budget (~`--scroll-pad` + 0.25 × ramp)
  — the strip is a fade, not a wall;
- the panel is fully clear past `--scroll-fade-span` — the ramp ends where it says.

Deviation is measured per pixel *row* (max across x), not on a single column, so
thin glyphs in a menu item still register.

## Files

- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css` — the `scroll-fade`
  utility: `::before` margin direction, drop `max-height`, new stop list, rewritten
  comment.
- `plugins/primitives/plugins/css/plugins/ui-kit/CLAUDE.md` — reconcile the fade
  section with what now ships.
- `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/shots.ts` + `index.ts` —
  the pixel-sampling helper.
- `plugins/primitives/plugins/css/plugins/ui-kit/e2e/scroll-fade-verify.ts` — the
  extent invariant and the geometry assertions.

Nothing in `use-scroll-fade.ts` changes: the hook is correct and was reporting the
truth it was given. The 1px slack stays (fractional line boxes, `alignItemWithTrigger`),
and it is *not* what should be absorbing a 4px lie.

## Verification

```bash
./equin build
bun plugins/primitives/plugins/css/plugins/ui-kit/e2e/scroll-fade-verify.ts --out /tmp/scroll-fade
```

- Every existing assertion still passes, plus the extent and geometry ones, in all
  six states.
- The `/`-filtered state is the regression: `44 / 44`, both fades off.
- Eyeball `/tmp/scroll-fade-turn-into-mid.png` — both edges dissolving, neither a
  wall. Compare against the current build's shot of the same state.
- `./equin check` for the repo checks.
