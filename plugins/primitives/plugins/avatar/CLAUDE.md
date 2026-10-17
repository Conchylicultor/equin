# avatar

Reusable circular avatar primitive — an icon on a colored disc, with an
optional status dot overlay (Slack-style). Pure web; no server, no slots.

## Size: density from context (no prop)

An `Avatar`'s size has **no prop** — it tracks the ambient `ControlSize`
(`useControlSize`), keying its `SIZE_MAP` bundle (box / icon / pinned status dot
/ ring offsets) off the four density tiers `xs | sm | md | lg`. Deliberate
sizing is a `<ControlSizeProvider size>` around the region (mirroring `Badge`),
never a per-instance `size`; passing one is a compile error (`size?: never`).
The no-provider default is `md`.

The fallback letter is part of that geometry, not text hierarchy: the box is a
size container (`@container-[size]`) and each bundle's `glyph` is a `cqh` share
of it (10px in the 16px `xs` disc up to 16px in the 48px `lg` one). A text role
would follow the theme's type scale while the box stays fixed, so no role is
used — and because the class-token lint walk follows a helper's return value
(`geometryFor` → `SIZE_MAP`), a raw `text-*` size in a bundle is reported.

## Presentation: badge, tile or gradient tile (from context)

How an avatar draws is also a region property —
`<AvatarPresentationProvider value>` / `useAvatarPresentation()`, modelled on
`ControlSizeProvider`:

- **`badge`** (default, no provider): the density-ramp size above and the SOFT
  paint (a 15% tint of the colour, the colour as the glyph).
- **`tile`**: the box fills its parent (the view sizes the tile, so density is
  ignored), the FLAT paint (the solid colour under the `categorical-foreground` glyph token, white by default), the glyph at
  46% of the box (svg by `size-[46%]`, a fallback letter by a `cqh` font size, as
  every presentation does), and the status dot has no ring.
- **`gradient-tile`**: the tile's box, the GRADIENT paint (the slot darkened
  0.28 in OKLCH lightness — `categorical-N-deep` — into the slot at 140°), the
  glyph at 54%, and an inset top highlight plus a drop shadow: an app icon shown
  as an object (the website's app gallery).

A field renders its avatar without knowing which one it is in; the launcher view
declares `tile` once around its items.

## Colour: one pick, three paints

`avatarColorPick(color, fallbackKey) → { slot, shade } | null` is the one rule:
an explicit known colour wins (shade 0); otherwise the key hashes to one of the
eight automatic slots (`hash % 8`) and a shade (`floor(hash / 8) % 2`), giving 16
tile colours. `null` is the neutral muted box. `avatarSoftClass(pick)` is the
badge paint (one per slot — the shade is ignored, so every badge is exactly what
it was before shades existed; `colors.test.ts` pins that for a fixed key set) and
`avatarFlatClass(pick)` the tile paint (10 slots × 2 shades, shade 1 =
`bg-categorical-N-lift`, the slot lifted 0.13 in OKLCH lightness, derived once in
ui-kit's `app.css` `@theme inline` block). `avatarColorClass` is
`avatarSoftClass(avatarColorPick(…))`. `avatarGradientClass(pick)` is the gradient-tile paint (one
per slot, the shade ignored).

The closed colour list (`AVATAR_COLOR_NAMES`, `AvatarColor`) and `AvatarShape`
live in `core/`, so a non-web descriptor (an app icon's declared colour) can type
a colour without importing web code.

## Components

- `<Avatar icon? color? shape? statusDot? fallbackGlyph? fallbackKey? colorless? />`
  — renders a badge or tile (see Presentation).
  - `shape`: `circle` (default, `rounded-full`) or `squircle` (the
    `rounded-squircle` utility — 26% of the box, a proportional shape outside
    the `--radius` scale like `rounded-full`).
  - `icon`: a saved Material Symbols name (`SavedSymbolName`, e.g.
    `"smart-toy"`), drawn as a runtime symbol (`runtimeSymbol`) in the
    surrounding theme scope's icon style — so a stored avatar restyles with
    the theme. `symbol` is the code-named alternative (an app's icon).
  - `color`: key into `AVATAR_COLORS` (Tailwind hue names). Falls back to a
    deterministic auto-color derived from `fallbackKey` (or `icon`) when null.
  - `statusDot`: a Tailwind background class (e.g. `bg-amber-500`). When
    set, renders a small dot bottom-right with a ring matching the surface
    bg, like Slack's presence indicator.
  - `fallbackGlyph`: a single character (first char used, uppercased) rendered
    centered when there is no icon, so the disc is never blank. Sized per
    density via the box's own `text-*` class. Providing it also tints the
    disc via the deterministic auto-color (unless `color` is set or `colorless`).
  - `fallbackKey`: stable key feeding the deterministic auto-color hash.
  - `colorless`: forces the neutral muted disc, ignoring `color`, the
    auto-color, and any `fallbackGlyph` tint.
- `<AvatarPicker value onChange children />` — popover trigger that opens
  a color row + the shared `<IconPicker>` (from the `icon-picker` primitive) +
  a clear row. Calls `onChange` immediately on selection (no submit). The
  trigger is whatever you pass as children (typically an `<Avatar>`).

  It is a `ControlPanelPopover` whose grid section declares `needs="picker"`, not a hand-rolled `Popover`: the
  swatch cluster, the icon block and the Clear row inherit ONE content inset
  from the panel, and the rules between the three bands are the container's —
  there is no `h-px bg-border` here to place, forget or double. The swatch grid
  itself is unchanged: `ControlPanel` owns geometry, never content layout.

## Relationship to `icon-picker`

The Material Symbols browse/search grid lives in the
[`icon-picker`](../icon-picker/CLAUDE.md) primitive. `avatar` composes
`<IconPicker>` and adds only its own concerns: the colored disc (`<Avatar>`),
the color palette, and `AvatarSpec` (a picked `SavedSymbolName` + a colour).
Nothing about the drawing is stored — `<Icon>` draws the name.

## Why a separate primitive

Future surfaces (per-user identity, per-task icons, contact rows in
chat-style panes) will all consume the same primitive. Keeping it
self-contained avoids each consumer reinventing the colored disc and
color palette.


<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Reusable circular avatar (icon + color) with an optional status-dot overlay and a chooser popover.
- Web:
  - Uses:
    - `primitives/css/cluster.Cluster`
    - `primitives/css/control-panel.ControlPanel`
    - `primitives/css/control-panel.ControlPanelPopover`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.ControlSize`
    - `primitives/css/ui-kit.DensityControlled`
    - `primitives/css/ui-kit.useControlSize`
    - `primitives/icon-picker.IconPicker`
    - `ui/icons.Icon`
  - Exports (types):
    - `AvatarColorPick`
    - `AvatarPickerProps`
    - `AvatarPresentation`
    - `AvatarProps`
    - `AvatarSpec`
  - Exports (values):
    - `Avatar`
    - `AVATAR_COLOR_KEYS`
    - `avatarFlatClass`
    - `AvatarPicker`
    - `AvatarPresentationProvider`
    - `avatarSoftClass`
    - `DEFAULT_AGENT_AVATAR`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/categorical --categorical-1`
    - `ui/tokens/categorical --categorical-10`
    - `ui/tokens/categorical --categorical-2`
    - `ui/tokens/categorical --categorical-3`
    - `ui/tokens/categorical --categorical-4`
    - `ui/tokens/categorical --categorical-5`
    - `ui/tokens/categorical --categorical-6`
    - `ui/tokens/categorical --categorical-7`
    - `ui/tokens/categorical --categorical-8`
    - `ui/tokens/categorical --categorical-9`
    - `ui/tokens/categorical --categorical-foreground`
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/place-palette --place-food`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-medium`
  - Imported by:
    - `apps-core/app-icon`
    - `apps/mail/reading-pane`
    - `apps/website/pages/apps`
    - `conversations/agents`
    - `conversations/conversation-category`
    - `conversations/conversation-ui/item`
    - `conversations/conversation-view/jsonl-viewer/teammate-message`
    - `fields/avatar/config`
    - `fields/avatar/table`
    - `page/place`
    - `primitives/data-view/icons`
- Core:
  - Exports (types):
    - `AvatarColor`
    - `AvatarShape`
  - Exports (values): `AVATAR_COLOR_NAMES`
- Test helpers:
  - Web: `@plugins/primitives/plugins/avatar/web/testing`
    - `AVATAR_COLORS`
    - `avatarColorClass` — The soft (badge) class for a colour / fallback key — `avatarSoftClass(avatarColorPick(…))`.
    - `useAvatarPresentation` — Reads the ambient avatar presentation.

<!-- AUTOGENERATED:END -->
