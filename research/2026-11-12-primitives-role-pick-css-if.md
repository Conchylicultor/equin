# Role pick without per-element style queries

## Context

`<Text pick>` (and `rolePickClass` on header/soft cells, card meta lines) is how a
THEME picks a part's type: three tokens name a rung of the closed ladder, a shared
weight and a family. Today `role-pick.ts` emits the fallback rung plus ~25
`[@container_style(--role-pick:<rung>)]:text-<rung>` classes (and emphasis /
family / compact-step ones) on every such element. Each is a style container query
Chromium evaluates per element on every restyle.

Measured on main (Sonata, 379 picked elements of 16k, forced whole-document
restyle, median of 15, interleaved):

| variant | style recalc |
|---|---|
| current (~28 style-query classes / element) | 212 ms |
| one style-query class / element | 108 ms |
| no pick classes at all | 100 ms |
| same dispatch as `if()` declarations (prototype) | ≈ no-pick (+6 ms) |

So the cost is per *query rule* matched on the element (~10 µs each), not the
dispatch itself. A declaration-level `if(style(...))` reads the element's own
(inherited) custom properties and costs about nothing.

## Design

Same tokens, same generic vars, same outcomes — only the dispatch moves from
rules into declarations.

1. **Two classes, `role-pick` and `role-pick-compact`**, defined once in ui-kit's
   `app.css`, inside a cascade layer `role-pick` declared AFTER Tailwind's
   `utilities`. Each sets `font-size`, `line-height`, `font-weight`,
   `letter-spacing`, `font-family` with one `if()` over `--role-pick`
   (compact: `and style(--role-step: ambient|base)`), weight also over
   `--role-emphasis`, family over `--role-family`.
2. **"No opinion" is `revert-layer`**: a rung whose utility does not set a
   property (letter-spacing on most rungs, weight on 2xs/3xs, family on all but
   `code`, emphasis/family `role`) reverts to the utilities layer — i.e. exactly
   what the fallback class and the caller's classes give today, where the query
   classes layered over them. Emphasis `parent` matches no branch → invalid at
   computed-value time → `font-weight` inherits; later an explicit `inherit` branch (today's `[font-weight:inherit]`).
3. **Unset tokens**: `rolePickScope` writes `--role-pick: var(<token>, <fallback>)`
   (and `role` for emphasis / family), so an `initial` token draws the part's
   fallback rung through the same path.
3b. **Engines without `if()`** (Safari, Firefox — `if()` is Chromium 137+ only
   in Nov 2026; WebKit is a target: the Tauri shell, phones, the website). The
   `if()` block sits behind `@supports (if())` — NOT left to be "dropped at
   parse time": a declaration holding `var()` is never validated at parse, so
   it would be kept and turn invalid at computed-value time, inheriting over
   the element's own classes. A second generated block, `@supports not
   (if())`, re-expresses the same picks as `@container style()` rules on the
   same two classes (exactly the old behaviour and cost, only there). A style
   query reads the parent's vars, so `<Text pick>` keeps its `display:
   contents` scope wrapper only in such an engine (`ROLE_PICK_SCOPE_ON_PARENT`,
   one `CSS.supports` read at module load); in Chromium the scope sits on the
   leaf.
4. **The block is generated, not hand-kept**: a pure `rolePickCss(utilities)` in
   the text plugin builds it from the `@utility text-<rung>[-compact]` declarations
   already in `app.css` (the one owner of every metric). Type-scale check rule 6's
   role-pick entry becomes "the block between the ROLE-PICK markers in app.css
   equals `rolePickCss(parse(app.css))`", printing the expected block on drift.
5. `rolePickClass(fallback, compact)` → `"<fallback rung classes> role-pick[-compact]"`.
   Callers (`Text`, data-table, card-meta, view switcher) unchanged.

Out of scope: the tooltip's own picker (11 classes, one element per open tooltip),
other one-off `@container_style` uses (column-header case, sort icon) — a handful
of elements, not per text.

## Verification

- In-page: computed font-size/line-height/weight/letter-spacing/family of every
  picked element identical before/after on main vs this build (Sonata, agent
  manager, a DataView table + gallery, settings control panel), several themes.
- Style cost: same forced-restyle benchmark on this build.
- `./equin test` text + data-view/data-table tests, `./equin check`,
  fullscreen-budget e2e, screenshots.
