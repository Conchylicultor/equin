# surface

The surface standard: one closed set of semantic **elevation roles** for every
panel, card, and overlay in the app, plus the lint rule that keeps it the single
source of truth. Routing depth through named roles is what lets a theme / preset
swap move the whole app's elevation *consistently* — instead of every call site
freezing its own ad-hoc `bg-* / border / shadow-* / rounded-*` recipe and the UI
reading as a flat box-in-box.

## The scale

`<Surface level>` (the only public export) applies a frozen bundle from
`SURFACE_LEVELS` (defined in `ui-kit/web/theme/surface.ts`, exported from the
ui-kit barrel). Every value is token-backed, so a color / shadow / shape preset
re-themes all surfaces of a role at once.

| level     | bundle                                                   | role                                            |
| --------- | -------------------------------------------------------- | ----------------------------------------------- |
| `sunken`  | `bg-muted`                                               | recessed well / band *below* the base plane     |
| `base`    | `bg-background`                                           | page / pane canvas, toolbar bands, sticky headers |
| `raised`  | `rounded-card border border-border bg-card shadow-sm`    | a card lifted one step above base               |
| `overlay` | `rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-popover-border` (+ `--hover-fill: var(--popover-hover)`, default `--selected`) | floats above all: popovers, menus, floating panels |

`raised`'s corners are the shape group's `radiusCard` token (`rounded-card`),
which defaults to the `rounded-md` step, so a theme can round its cards without
moving the rest of the radius scale.

`sunken` / `base` are tone-only (flush bands add their own `border-b` / radius via
`className`); `raised` / `overlay` are contained boxes. The bundles are plain
Tailwind class strings composed via `cn()`, so a consumer's `className` override
(`bg-muted/30`, `rounded-lg`, `shadow-none`, …) cleanly replaces just that
property — it does not nuke the whole surface.

`<Card>` is now a thin `<Surface level="raised">` + padding wrapper, and the
shadcn `PopoverContent` / `DropdownMenuContent` consume `SURFACE_LEVELS.overlay` —
one definition behind all three. Like `<Card>`, `<Surface>` bakes the Ctrl+A
select-scope into its root.

## `as` chooses the TAG, never the box (Surface owns `display`)

A surface is a **contained box**, so `<Surface>` emits `block` itself — ahead of the
level bundle and the consumer's `className`, so a real layout intent
(`flex` / `grid` / `hidden`) still wins through tailwind-merge. `display` is
deliberately *not* in `SURFACE_LEVELS`: the map is the elevation bundle
(bg + border + radius + shadow), and `sunken` / `base` are tone-only.

Without it, `as` silently changed the *box type* along with the tag, and the failure
is invisible until it isn't: an `<a>` is `display: inline` by default, and an inline
box containing block-level children is split into fragments, so the browser paints
the background / border / radius on the **empty leading and trailing fragments**
instead of around the content. The bookmark block shipped exactly that — two stray
1px slivers above and below the card and no card chrome at all, which reads as a
rendering artifact rather than a missing `display`. `<button>` (`inline-block`) hid
the same hole, and every other `as="button"` card happened to be a flex/grid item,
where the child is blockified anyway.

`className` still owns the *flow*: `<Card as="dl" className="grid …">` and
`<Card as="a" className="flex …">` are unchanged.

## Enforcement

`lint/no-adhoc-surface.ts` fails `./singularity check` on the two disambiguable
open-coded recipes, fingerprinted across one `className` attribute. The gate is
the **recipe, not the host tag**: the literal recipe is illegal on *any* host
element — an intrinsic (`<div>`/`<section>`/`<nav>`/…), a layout component
(`<Stack>`/`<SortableItem>`/…), or a member-expression tag (`<Foo.Bar>`). There is
no tag-allowlist to fail open through (the former `HOST_TAGS` gate did just that,
silently letting a recipe smuggled through a layout component's `className` slip).

- **raised** — `rounded` + `border` + the `bg-card` token + padding (this is the
  former `no-adhoc-card`, folded in here).
- **overlay** — the `bg-popover` token + a `shadow-*` + `rounded`.

There are exactly **two sanctioned homes** for the recipe, both invisible to the
gate by construction:

1. **The `SURFACE_LEVELS` member-access indirection** — `cn(SURFACE_LEVELS.raised,
   …)` reads the bundle off a member expression. The rule's token collector
   harvests *only* string literals, never member accesses, so the canonical
   sanctioned surface (and the `<Surface>` primitive itself, which composes the
   map) flows straight through. This literal-only walk IS the escape valve.
2. **The shadcn surface-primitive definition files** under
   `ui-kit/web/components/ui/` — the primitives that open-code the recipe as
   literal strings on base-ui `*.Popup` tags (they ARE the implementation behind
   `<Surface level="overlay">` / `PopoverContent` / `DropdownMenuContent`). They
   own the raw recipe and are exempted by a file-glob in `lint/index.ts`, exactly
   as `no-adhoc-layout` exempts the layout primitives that own raw mechanics.

`base` (`bg-background`) and `sunken` (`bg-muted`) are **not** hard-linted: those
tokens legitimately appear on dividers, hover states, chips, and bands without
being a contained surface, so there's no false-positive-free fingerprint. Use
`<Surface level="base">` / `level="sunken"` by convention; adopt incrementally.

A consumer's **partial override** (`<Card className="rounded-lg">`,
`<Surface level="raised" className="bg-muted/30">`) stays valid — it tweaks one
property, it does not re-spell the full recipe. Escape a genuinely-bespoke flagged
site per-site, travelling with the code: the named `p-card` padding token (raised —
a real density-scaling utility backed by `--pad-card`), or
`// eslint-disable-next-line surface/no-adhoc-surface -- <reason>`.

## Passthrough

`ref` and every prop `Surface` does not name land on the element `as` names — see
[the passthrough contract](../../../passthrough/CLAUDE.md). One exception to
"the spread wins": `onKeyDown` is composed with the select-scope handler and
applied *after* `{...rest}`, so a consumer's handler runs first and the scope can
never be clobbered.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Semantic surface elevation primitive: <Surface level> bundles background + border + radius + shadow into a closed set of roles (sunken/base/raised/overlay), plus the no-adhoc-surface lint rule.
- Web:
  - Uses:
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.SidewaysScrollProvider`
    - `primitives/css/ui-kit.SURFACE_LEVELS`
    - `primitives/css/ui-kit.SurfaceLevel`
    - `primitives/select-scope.scopeSelectAllKeyDown`
    - `primitives/select-scope.selectScopeProps`
  - Exports (types): `SurfaceProps`
  - Exports (values): `Surface`
- Cross-plugin:
  - Imported by: 30 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×9
    - `primitives` ×7
    - `page` ×4
    - `apps-core` ×2
    - `infra` ×2
    - `map` ×2
    - `conversations/agents`
    - `debug/queue`
    - `fields/json/config`
    - `stats`
- Exemptions:
  - Exempted by: `primitives/css/ui-kit` (0 debt)

<!-- AUTOGENERATED:END -->
