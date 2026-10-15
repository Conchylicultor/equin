# viewport-overlay

The sanctioned home for a **viewport-filling overlay** — fullscreen modes, the
element-picker and draw overlays, modal scrims. `<ViewportOverlay>` self-portals
to `document.body` and applies `fixed inset-0` + a z-layer, so its box is always
relative to the real viewport.

## Why this primitive exists

Several app surfaces deliberately put `transform-gpu` on a container to make it
the **containing block** for `position: fixed` app chrome (e.g. the per-tab
surface backdrop in `apps/surface`, so a shadcn sidebar's `fixed inset-y-0` clips
to the content area by design). The trap: any *other* descendant that uses
`fixed inset-0` to mean "fill the viewport" is then bounded by that transformed
ancestor and **silently clipped** to the content area — below the tab bar, right
of the rail — with no error. It only surfaces as a wrong-looking screenshot, and
already bit the per-tab solo mode once.

Routing every viewport overlay through `<ViewportOverlay>` makes that whole class
of bug structurally impossible: a portal to `document.body` escapes any
transformed ancestor, so the overlay fills the actual viewport every time.

## API

```tsx
<ViewportOverlay layer="popover" className="flex items-center justify-center bg-black/70">
  {children}
</ViewportOverlay>
```

- **`layer`** — `"popover"` (default, z-50) | `"draw"` (z-60) | `"max"` (z-9999).
  Picks the named z-utility; never write a raw z-index.
- **`className`** — extra classes for the overlay root (background, flex layout,
  pointer-events, …). The `fixed inset-0` + z-layer are baked in.

The overlay stamps `data-theme-scope` from `usePortalThemeScope()`, so themed
content keeps its originating surface's palette after the portal hop.

There is deliberately no prop to turn the portal off, for the reason below.

## The runtime auditor

The lint rule can only fingerprint the *recipe* (`fixed` + `inset-0` in one class
list). Whether a given box really reaches the viewport is a fact about its
ancestor chain, which crosses plugin boundaries and only exists once rendered —
so this plugin also owns the runtime check for the same invariant.

```ts
useViewportEscape(ref, { enabled, subject, remedy, from });
assertViewportEscape(el, { subject, remedy, from });  // the imperative twin
findViewportBlocker(el);                              // the walk, no reporting
```

`findViewportBlocker` walks from an element up to `<html>` and returns the first
ancestor that breaks one of two promises: **containing block** (`transform` /
`translate` / `rotate` / `scale` / `perspective` / `filter` / `backdrop-filter` /
`will-change` / `contain` / `container-type` — the box is clipped to that element
instead of the window) or **stacking context** (`opacity` < 1 / `isolation` /
`mix-blend-mode` / a positioned element with a numeric `z-index` — the box's
z-index is compared inside that layer, so it stops covering the chrome beside it
however high it is set). `null` is the clear chain.

The walk is pure CSS and names nothing: **`subject`** ("a fullscreen (solo) tab")
and **`remedy`** are strings the caller supplies, and they are the only domain
knowledge in play. **`from`** picks where the walk starts: `"self"` (default)
when the element is an ancestor that HOSTS fixed children (what
`apps-core/surface` passes for its backdrop), `"parent"` when the element IS the
fixed box — a `position: fixed` element is its own stacking context, so an
inclusive walk would report every overlay against itself.

Both faults report to `viewportEscapeReportSink` and then throw under
`import.meta.env.DEV`. The sink holds its first reports until something registers it;
`plugins/reports/plugins/viewport-escape` is the consumer that files them as
reports, and an app composition without it drops every production fault.

`<ViewportOverlay>` audits its own chain in dev with `from: "parent"`. A portal
to `<body>` escapes every ancestor *inside* the app — that is the point — but it
cannot escape `body`/`html` themselves, so a global `filter`/`transform` there (a
blur-while-locked scrim, a devtools frame, an extension that wraps the page) is
still a containing block. That is the one failure this primitive's design cannot
make impossible, which is why it is checked rather than assumed.

## A portal toggle is not keep-alive

Conditional portals get reached for as a way to move a subtree without losing it.
They do not do that. React reconciles a portal by **the identity of its
container**:
`reconcileSinglePortal` reuses the existing fiber only when the current child is
already a `HostPortal` with the same `containerInfo`. So both of these delete the
subtree and build a new one — every bit of state inside it (a scroll offset, an
uncommitted edit, a loaded `<iframe>`) is gone:

```tsx
cond ? createPortal(children, document.body) : <>{children}</>  // element kind changes
createPortal(children, cond ? a : b)                            // container changes
```

Two things actually keep a subtree alive across a layout change, and neither is a
branch:

- **Stop moving it.** A `fixed` box only needs a portal because some ancestor is
  its containing block. Drop that ancestor's `transform` / `filter` /
  `will-change` while the fullscreen layout is active and nothing has to move at
  all — what `plugins/apps-core/plugins/surface` does for the solo placement.
- **Mint one stable container and re-parent it imperatively.** Always portal into
  the same element, then move that element with plain DOM calls React never
  sees — `plugins/primitives/plugins/adaptive-bar`, under "Why one stable
  container per item", which also lists what a re-parent costs (an `<iframe>`
  reloads, focus and pointer capture are lost).

`web/__tests__/portal-toggle-remounts.test.tsx` is the measurement, including the
positive control that an unconditional overlay keeps one instance.

## Enforcement

`lint/no-adhoc-viewport-overlay.ts` fails `./singularity check` on the
viewport-fill recipe — `fixed` + `inset-0` co-occurring, aggregated across one
class-name attribute (`className`/`class`, or a `*ClassName` pass-through prop) or
one `cn`/`clsx`/`twMerge` call. Both anchors matter: the recipe is just as wrong
when it is assembled into a `const c = cn("fixed", "inset-0")` and spread onto an
element a few lines later.

The gate is the **recipe, not the host tag** — it fires on any element. There is
no tag allowlist to fail open through (the former `span`/`div`/`button`/`a` gate
did just that). What stays invisible is instead structural: the primitive keeps
the recipe in a module const the literal-only token walk never harvests, and the
shadcn dialog/sheet definitions under `ui-kit/web/components/ui/` (really portaled
by base-ui) are exempted by the same `lint/index.ts` file-glob `no-adhoc-surface`
uses for those files.

Escape a genuinely-contained case with `absolute inset-0` (for a pane-relative
overlay) or
`// eslint-disable-next-line viewport-overlay/no-adhoc-viewport-overlay -- <reason>`.

`lint/no-portal-toggle.ts` fails on a `createPortal` put behind a condition — a
ternary or a multi-return function that yields a portal on one path and something
non-`null` on another, or a conditional container argument. `… : null` /
`return null` stay valid: a genuine mount/unmount is not a false keep-alive
claim.

## Passthrough

`ref` and every prop the primitive does not name land on the portal root — the
`fixed inset-0` box — per
[the passthrough contract](../../../passthrough/CLAUDE.md). The primitive needs a
handle on that same node for the runtime audit, so it **composes** the caller's
`ref` into its own callback; writing its own `ref=` after `{...rest}` instead
looks equivalent and silently discards the caller's.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Viewport-filling overlay primitive: self-portals to document.body + z-layer + theme-scope so fixed inset-0 fills the real viewport, never a transformed ancestor. Also owns the runtime auditor for the same invariant — the containing-block + stacking-context ancestor walk (assertViewportEscape / useViewportEscape), which reports the two ways a fixed box silently stops being viewport-relative.
- Web:
  - Uses:
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.usePortalForwardedAttrs`
    - `primitives/css/z-layers.PortaledLayer`
    - `primitives/css/z-layers.zLayerClass`
  - Exports (types):
    - `ViewportBlocker`
    - `ViewportBlockerReason`
    - `ViewportEscapeFault`
    - `ViewportEscapeFaultKind`
    - `ViewportEscapeOptions`
    - `ViewportOverlayProps`
  - Exports (values):
    - `assertViewportEscape`
    - `describeElement`
    - `findViewportBlocker`
    - `useViewportEscape`
    - `viewportEscapeReportSink`
    - `ViewportOverlay`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `apps-core/surface`
    - `apps/prototypes/present`
    - `apps/sonata/audio/metronome`
    - `page/editor`
    - `primitives/adaptive-bar`
    - `primitives/overlay/floating-surface`
    - `primitives/overlay/image-viewer`
    - `primitives/ui-context/element-picker`
    - `reports/viewport-escape`
    - `screenshot/draw-on-app`
- Exemptions:
  - Exempted by: `primitives/css/ui-kit` (0 debt)

<!-- AUTOGENERATED:END -->
