# Own-box class tokens for fingerprint lint rules

## Context

`control-size/no-adhoc-control` flags a raw `<button>`/`<a>` carrying fixed height +
horizontal padding + rounded. It reads every token through the shared toolkit's
`baseClass`, which strips *all* variant prefixes — so `after:h-0.5 after:rounded-full`
(an underline-tab indicator drawn on `::after`) counts as the button's own height and
radius, and a `px-3` tab with an underline is reported as a hand-rolled button.

The root cause is not this rule: `baseClass` cannot tell a variant that *conditions*
the element (`hover:`, `md:`, `dark:`, `data-[x]:`, `group-hover:`, `[&:focus]:`) from one
that *retargets* the utility to another box (`after:`, `before:`, `placeholder:`,
`file:`, `marker:`, `selection:`, `first-line:`, `first-letter:`, `backdrop:`,
`details-content:`, `*:`, `**:`, an arbitrary `[&>svg]:` / `[&_svg]:` / `[&::x]:`).
Every rule that fingerprints "what does THIS element look like" inherits the bug.

## Design

Two questions, two toolkit functions (`lint/core/class-token-walk.ts`, injected via
`LintToolkit`):

- `baseClass(token)` — unchanged: the utility, whatever box it lands on. For
  **value rules** (radius, spacing, typography, z-index, colour): an
  `after:rounded-[3px]` is still an ad-hoc radius.
- `ownClass(token): string | undefined` — **new**: the utility if it styles the
  element itself, `undefined` if any variant retargets it to a pseudo-element or
  descendant. For **fingerprint rules** — they ask about the element's own shape.

Retargeting = a named pseudo-element/child variant from a closed list, or an
arbitrary `[…]` variant whose selector, after its `&`, has a combinator
(`>`, `+`, `~`, `_`/space) or a `::` pseudo-element. An `&`-less arbitrary variant
(e.g. `[@media(…)]:`) conditions the element.

Variant splitting respects brackets (`[&:hover]:` contains a `:`).

## Migrated rules (fingerprint rules using `baseClass`)

- `control-size/no-adhoc-control` (the reported bug), `control-size/no-adhoc-density`
- `bar/no-adhoc-bar`, `pane/no-adhoc-pane-toolbar`, `surface/no-adhoc-surface`,
  `viewport-overlay/no-adhoc-viewport-overlay`, `text/no-clip-without-nowrap`,
  `ui-kit/no-button-shadow`

Value rules keep `baseClass`. Migration can only *remove* reports (a subset filter).

## Verification

- Unit test for `ownClass` (conditioning vs retargeting variants, bracketed variants).
- New `no-adhoc-control.test.ts`: `after:h-0.5 after:rounded-full px-3` on a `<button>`
  passes; `h-7 px-3 rounded` and `hover:rounded-md h-7 px-3` still fail.
- `./equin check eslint` / `type-check` over the repo (no newly-unused disable directives).
