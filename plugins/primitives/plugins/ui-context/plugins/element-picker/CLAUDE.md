# element-picker

Point at any element on the live app and get its `<ui-context>` metadata — the
full plugin/slot **composition lineage**, the containing region, the URL and a
fine-grained element descriptor (tag + role + accessible label + an id/test-id
anchored CSS path). The token format, the lineage grammar and `collectMeta` are
the parent `ui-context`'s; this plugin owns the interaction, the one producer
that has to be opt-in, and the chip that draws a token.

It imports only primitives, so any composition can pick — the equin website's
Improve popover as well as Singularity's own (`improve/element-picker`, which is
now just the action-bar and task-draft buttons on top of `PickerButton`).

## API

```tsx
<ElementPicker
  onPick={(meta: UiContextMeta) => …}      // after the picker has disarmed
  onArmedChange={(armed) => …}             // optional: mirrors "overlay is up"
  hint="Click the part you mean"           // optional: the bottom pill
  trigger={({ armed, arm }) => <Button onClick={arm}>…</Button>}
/>
```

A component, not a hook handing back an overlay: "arm it, then remember to
render the overlay" is easy to get half-wrong. `onArmedChange` fires from one
effect keyed on `armed`, so it also reports `false` when the picker unmounts
mid-pick — a host that hid itself for the pick is never left hidden.
`PickerButton` is the `IconButton` form.

## How the pieces fit

- **Overlay.** `picker-overlay.tsx` is a `fixed inset-0 z-max` portal with
  `pointer-events:none` so `document.elementFromPoint` returns the real
  underlying element. Window capture-phase `mousemove`/`pointerdown`/`click`/
  `keydown` track the hovered element, select on click, and cancel on Esc.
  `pointerdown` is swallowed (`preventDefault` + `stopPropagation`) so a pick
  launched from inside an open popover is not read as an outside press.
- **The hint pill** is the overlay's one hit-testable part (`pointer-events-auto`)
  and sits inside `[data-element-picker]`, so the pointer over it resolves no
  target: no highlight, and its Cancel's `click` passes through untouched. Its
  `pointerdown` is swallowed like a pick's, for the same popover's sake. Esc and
  Cancel share one cancel path.
- **Hit-testing ignores `pointer-events`** (`internal/resolve-target.ts`).
  `elementFromPoint` answers "what would receive a click here?" — the app's
  interactivity policy — but picking is inspection. Disabled controls, icon
  glyphs and click-through layers are invisible to it and mis-resolve to their
  nearest interactive *ancestor*, so it only **seeds** the search: descend to the
  deepest visible descendant containing the point. `<svg>` subtrees are not
  descended into (the glyph stands in for its host control); boxless
  (`display:contents`) marker spans are traversed, never selected. `PickerButton`
  stays `disabled` while armed on purpose: picking its own (non-hit-testable)
  button each e2e run is the live regression test for this.
- **The contribution producer — opt-in.** `internal/marker-middleware.tsx`
  registers `contributionNodeAttrs` (`data-lineage="contribution"` +
  `data-plugin-id` / `data-slot-id` / `data-contribution-id`) with
  `registerSlotItemAttrs`, and slot-render stamps them on the one box it draws
  around each contribution — see `slot-render`'s "The contribution box, and
  stamping it". Attributes, not a wrapper: a wrapper sat inside the layout cell a
  row slot draws, so a pick in the slack around a small widget climbed past the
  whole contribution to the enclosing pane. The middleware that remains renders
  no element — it only appends the same node to the portal-forward bridge, which
  needs a provider. It is a side-effect import of THIS barrel, never the
  parent's: it describes every slot contribution repo-wide, so that cost is paid
  only where something that can pick is in the composition. (`<UiRegion>`, the
  other producer, is unconditional in the parent.)
- **The chip.** `components/ui-context-tag.tsx` is an inline chip
  (`InlineChip.Tag(inlineChip({ id: "ui-context", pattern: UI_CONTEXT_RE,
  surfaces: ["transcript"], … }))`, from `text-editor/inline-chip`): it parses
  the matched `<ui-context>…</ui-context>` substring back into metadata and
  renders `UiContextChip`, whose popover lists every `UI_CONTEXT_FIELDS` entry.
  This is the ONLY registration (a duplicate id throws), and it renders on every
  surface of that kind — every `TextEditor` through the generic inline-chip node,
  and markdown / user-text through active-data's linkify. The token is
  single-line so it round-trips the editor's line-based markdown sync; copy/paste
  survives because the generic node emits the raw tag as its text content.

  **It lives with the picker** because a plugin enters a composition only through
  an import: whoever can make the token must be able to draw it. It cannot live
  in the `ui-context` barrel: the chip boundary needs `error-boundary`, which
  imports `ui-context`.

  **`surfaces: ["transcript"]`, deliberately.** A `<ui-context>` tag points at a
  live UI element captured for one agent turn; it is addressed to the model
  reading that draft or conversation and means nothing in a page a person wrote.

## `source` and `owner` come from a build transform elsewhere

The `source` / `owner` fields read `data-source` / `data-ui-owner`, which
`improve/element-picker`'s `vite/` Babel transform stamps. That transform is
discovered by a filesystem walk, not by composition, so the attributes exist in
every build — including a composition this plugin is not in.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Chrome-inspector-style element picker: <ElementPicker> arms a full-screen overlay, the user hovers and clicks any element, and onPick receives its <ui-context> metadata (plugin/slot lineage, selector, source). Also declares the <ui-context> inline chip, so whatever can make the token can display it, and stamps every slot contribution with its lineage while in the composition.
- Web:
  - Contributes: `InlineChip.Tag` "ui-context" → `UiContextTag`
  - Uses: 33 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×5
    - `primitives/ui-context` ×5
    - `primitives/css/coords` ×3
    - `primitives/css/fill` ×2
    - `primitives/css/spacing` ×2
    - `primitives/icon-button` ×2
    - `primitives/overlay/tooltip` ×2
    - `primitives/slot-render` ×2
    - `primitives/text-editor/inline-chip` ×2
    - `primitives/css/link-chip.LinkChip`
    - `primitives/css/pin.Pin`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/text.Text`
    - `primitives/css/viewport-overlay.ViewportOverlay`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/overlay/popover.InlinePopover`
    - `ui/icons.Icon`
  - Exports (types): `ElementPickerProps`
  - Exports (values):
    - `ElementPicker`
    - `PickerButton`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-foreground`
    - `ui/tokens/shadow --shadow-lg`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-size-label`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-caption`
    - `ui/tokens/type-scale --line-height-label`
  - Imported by:
    - `apps/website/improve`
    - `improve/element-picker`

<!-- AUTOGENERATED:END -->
