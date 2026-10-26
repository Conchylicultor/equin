# Z-stack: plugin-declared top layers, ordered by a committed layout

## Context

The Ask equin card (`hints/ask`) sits on `z-popover` (50) while hint tips sit on
`z-guide` (55), so a show-me pointer paints over the card that produced it. The
wanted order is `popover < hints < ask < draw < toast < max`.

The root cause is the ladder's shape, not one value: `z-layers` owns a closed,
hand-numbered list (`app.css` `--z-*` + `layers.ts`) that names other plugins'
surfaces (`guide` = hints, `draw` = draw-on-app, `toast` = the toaster). A new
app-wide surface either reuses a generic layer (the Ask card took `popover` and
lost by tree order) or edits a primitive to insert a number between two others —
the collection owner naming its contributors.

Outcome: a top-level surface declares its own layer in its own plugin; the order
of all declared layers is one committed layout file; adding a layer cannot land
until someone places it in that file.

## Design

**Reuse the reorder layout machinery wholesale.** A reorderable slot already gets
everything this needs, with no new codegen:

- the build materializes the slot's catalog (every contribution's
  `pluginId:id`) into the origin `config/<owner>/<slot>.origin.jsonc`, hashed;
- a new contribution shifts the hash → `./equin build` stamps `// @review` into
  the committed override, `config:overrides-authored` /
  `config-origins-in-sync` fail → `push` is blocked until it is placed;
- the web reads the order with `useSlotOrder(slot)` (config is
  `boot-and-keep`, ready at first paint); web + server descriptors are
  registered from the generated `reorderableSlots` manifest.

The only missing piece is a reorderable slot whose contributions are **data**,
not components: render slots need a `component`, ordered-dispatch slots a
dispatch key + component. So:

1. **`defineOrderedSlot<P extends { id: string }>()`** in `primitives/slot-render`
   — `defineSlot` + `meta = { kind: "ordered", reorderable: true }`, sibling of
   `defineOrderedDispatchSlot`. A generic primitive: an open, user-ordered list of
   data contributions read through `useSlotOrder`. Touches the `SlotMeta.kind`
   union (`slot-declaration/core`), the slots facet parser/`BUILDER_KIND`
   (`plugin-meta/facets/slots`), and its `core/types.ts`.

2. **New plugin `primitives/css/z-layers/plugins/stack`** (web):
   - `ZStack.Layer = defineOrderedSlot<{ id: string; label: string }>()`.
   - A plugin declares a layer as a contribution value in its own module
     (`export const AskLayer = ZStack.Layer({ id: "ask", label: "…" })`), lists it
     in its barrel `contributions`, and passes the same value to its host. The
     value is the handle — there is no other way to name a stack layer.
   - `useZStackIndex(layer): number` — the layer's z-index:
     `STACK_FLOOR + 1 + position` in `useSlotOrder(ZStack.Layer)`, where
     `STACK_FLOOR` is the popover value (50); the stack sits strictly between
     `popover` and `max` (9999). Throws if the layer is not contributed (its
     plugin forgot the barrel entry) or if two plugins contribute the same `id`
     (the handle carries only the id — contributions are copied when stamped).
   - Values are only ever relative, so a deferred tier loading later shifts
     numbers but never the order.

3. **`z-layers` shrinks to generic roles only.** `PortaledLayer` becomes
   `"popover" | "max"`; `--z-guide`, `--z-draw`, `--z-toast` and their `@utility`
   classes are deleted from `app.css` (custom-utilities codegen follows).
   `no-adhoc-zindex`'s messages point a new top-level surface at `ZStack.Layer`.

4. **`ViewportOverlay` takes `layer: PortaledLayer | ZStackLayer`.** For a stack
   layer it sets `style.zIndex` from `useZStackIndex` and wraps children in
   `PortalHost` (`primitives/overlay/portal-host`): a surface above the popover
   layer must draw its own popups (a tooltip in the Ask card would otherwise
   portal to `<body>` at 50, under the card). Making that automatic removes the
   whole class. `PortalHost` gains an optional `className` so the host element can
   be `pointer-events-auto` under a `pointer-events-none` overlay root.

5. **Move the four surfaces onto declared layers**, each in its own plugin:
   - `hints` → `HintsLayer` (`hint-host.tsx`, was `layer="guide"`)
   - `hints/ask` → `AskLayer` (`ask-host.tsx`, was `layer="popover"`)
   - `screenshot/draw-on-app` → `DrawLayer` (`live-draw-overlay.tsx`, was `"draw"`)
   - `shell/toast` → `ToastLayer`: sonner's inline `zIndex` and the dismiss-all
     strip both read `useZStackIndex(ToastLayer)` (was `var(--z-toast)` /
     `z-toast`).

6. **Commit the order**: `config/…/z-layers/stack/<slot>.jsonc` =
   `hints:hints, hints.ask:ask, screenshot.draw-on-app:draw, shell.toast:toast`
   (exact keys from the build-generated origin), `@review` removed.

Out of scope: the in-tree tier (`base…overlay`) — generic roles the primitives
own, naming nobody. A user-layer override of the order is possible (config_v2
has no git-only descriptor); not addressed here.

## Critical files

- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` (+ barrel)
- `plugins/framework/plugins/slot-declaration/core/declaration.ts`
- `plugins/plugin-meta/plugins/facets/plugins/slots/{facet/index.ts,core/types.ts}`
- new `plugins/primitives/plugins/css/plugins/z-layers/plugins/stack/`
- `plugins/primitives/plugins/css/plugins/z-layers/{web/internal/layers.ts,lint/no-adhoc-zindex.ts,CLAUDE.md}`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`
- `plugins/primitives/plugins/css/plugins/viewport-overlay/web/internal/viewport-overlay.tsx`
- `plugins/primitives/plugins/overlay/plugins/portal-host/web/internal/portal-host.tsx`
- the four hosts above + their `web/index.ts`

## Verification

- `./equin build` seeds the stack override with `@review` (proves the forcing);
  place the four entries, rebuild clean; `./equin check` green.
- Drive the build: open Ask, trigger a show-me → the hint pointer paints under
  the card; a tooltip inside the Ask card shows above it; a toast shows above the
  card. Read the computed z-indexes with `browser_javascript`.
- Delete one entry from the committed order → build re-marks it, checks fail.
