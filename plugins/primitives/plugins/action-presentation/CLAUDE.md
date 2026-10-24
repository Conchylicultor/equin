# action-presentation

A widget in a bar and the bar that hosts it must agree on what happens when the
room runs out. The bar knows the width; only the widget knows which smaller
versions of *itself* still work. This plugin is the channel between them.

```tsx
// The widget offers rungs and reads back the one it got — one hook, both ways.
const form = useActionForm({ shrinksTo: ["compact"], yields: "early" });
if (form === "compact") return <IconButton icon={VolumeIcon} label="Volume" onClick={toggleMute} />;
return <VolumeSlider />;
```

A **rung** (`"full" | "compact" | "row"`) names a form the widget renders itself
as, never a place — a widget rendered as itself inside a floating panel is still
`"full"`, and is never told where it is. `yields`
(`"never" | "late" | "normal" | "early"`) says how eagerly it gives up room
*relative to its neighbours*, because the bar cannot rank its own occupants: they
come from different plugins and it can name none of them.

## The invariant: you only get a form you offered

`useActionForm` returns the region's assignment only when that form is `"full"`
or is in **this caller's own** `shrinksTo`; otherwise `"full"`. Enforced in the
hook, not trusted of the region — including on the first commit, where the
assignment (context, already committed) leads the declaration (an effect, still
queued).

That filter is the design. The old `<ActionPresentation mode="menu">` blanketed a
subtree, so a bar could turn anything below it into a labelled row. An icon
button survives that losslessly; a volume slider or a jog wheel cannot be a
labelled row at all, and the rule against putting one in such a region was prose
in this file. Now a widget that never writes `"row"` cannot be handed `"row"` by
any region, present or future.

## Declaring nothing is safe

`useActionForm()` with no argument — or never calling it — is a one-rung ladder
at `yields: "normal"`: the bar may leave the widget alone or relocate it as
itself, and nothing else. **With no bar above it returns `"full"` and the
declaration is a no-op**, which is every ordinary call site, so the ~90 plugins
rendering an `IconButton` in plain chrome are untouched.

## Why report-up

The ladder flows *up*; context only flows down. DOM data-attributes were rejected
for this case: between a bar and a contributed widget sit `renderIsolated`'s
error boundary, the reorder item middleware and `.Render`'s own wrapper, so there
is no "the widget's root element" to attribute. Static contribution metadata
fails too — eagerness is per-instance and dynamic: every tab is the same
component, and only the *focused* one says `yields: "never"`. So: an effect-time
registration into the nearest item scope, the `useReportPopupOpen` shape.

`declare` is keyed on a serialization of the ladder (`shrinksTo.join(",")`
+ `"|"` + `yields`), never object identity — call sites pass an inline literal,
so identity churns every render and would thrash the region's ledger.

## One declarer per item — `ActionFormShield`

A region mounts one channel per ITEM, and every `useActionForm` below it
declares into that channel, replacing whatever was declared before. So a widget
that declares its own ladder and renders `IconButton`s inside itself (a version
stepper's ‹ ›) has them declare `["row"]` over it, and which ladder the item
ends up with depends on effect order — the stepper lost its `compact` rung and
was relocated whole. Wrap such a widget's inner controls in
`<ActionFormShield>`: below it there is no region, so they render at `"full"`
and declare nothing. The bar also ignores the release of a declaration that has
since been replaced, so an inner control unmounting can no longer reset a
still-mounted widget's ladder. Detecting a second live declarer loudly is not
done yet.

## Holds

`useHoldShrink(active)` freezes an item's assignment while a live interaction is
in flight; the bar re-fits everything *around* it and applies the stored target
on release (so "deferred forever" is unrepresentable). Only for what survives the
pointer release — an inertial fling's coast. The bar pins the item under an
active pointer itself, and `PopupOpenScope` pins one whose own popover is open.

## `PanelActionRow` — a row, not a menu item

The renderer of the `"row"` rung, and it **renders standalone**: no menu, no
popover, no context above it. That is forced, not stylistic. The overflow panel
holds relocated widgets' live DOM (a Web Audio volume control, a jog wheel
mid-drag), so it must stay mounted — and `DropdownMenuContent` unmounts its
children on close. The panel is therefore a plain dialog, where `role="menu"`
would also be wrong: a menu's roving tabindex and typeahead eat the arrow keys a
relocated `role="slider"` needs. Honest cost: **the panel is Tab + Enter + Esc,
with no typeahead and no arrow-key roving.**

It composes `Row`, which is right here precisely because `Row` stamps **no
`role`** — it cannot turn this into a `menuitem`. It passes
`disabled={disabled ?? false}`: both `onClick` and `disabled` are optional, and
`Row` infers a non-interactive `<div>` when both are absent.

Takes the **raw** shortcut string and formats it through the same
`formatShortcutLabel` as the full form, so the two cannot drift. `IconButton` is
the one widget that declares `"row"` — it *is* the generic
`{ icon, label, onClick }` shape — so everything built on it inherits the rung,
and `variant` / `className` / `tooltip` / `side` are INERT in that form.

## Why there is no `probe`

`probe` answered *"is this bucket empty for THIS row?"* (an action returns `null`
for a row it does not apply to, and an `⋯` with nothing behind it is dead chrome)
by instantiating every member a second time to draw nothing and be counted. A bar
mounts each item exactly once into its own container, so the same question is a
one-line DOM read in the layout effect that already measures:
`container.childElementCount === 0`. Strictly better — the probe counted
`IconButton`s and was blind to a member that hand-rolled its markup — and no
second mount. `ActionPresenceScope` / `useReportActionPresence` went with it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The shrink-ladder seam between a widget and the bar that hosts it: useActionForm declares the smaller forms a widget can render ITSELF as (and how eagerly it yields room to its neighbours) and reads back the form the region assigned — one hook, both directions. A region can only hand a widget a form that widget declared, so a rich control can never be transformed into something it is not; PanelActionRow renders the 'row' rung, the one IconButton declares — a labelled row that stands alone in the always-mounted overflow panel, never a menu item.
- Web:
  - Uses:
    - `primitives/css/fill.Fill`
    - `primitives/css/row.Row`
    - `primitives/css/text.Text`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/overlay/tooltip.Kbd`
    - `primitives/shortcuts.formatShortcutLabel`
    - `ui/icons.Icon`
  - Exports (types):
    - `ActionForm`
    - `ItemFormChannel`
    - `PanelActionRowProps`
    - `ShrinkLadder`
    - `YieldEagerness`
  - Exports (values):
    - `ActionFormProvider`
    - `ActionFormShield`
    - `PanelActionRow`
    - `useActionForm`
    - `useHoldShrink`
- Cross-plugin:
  - Imported by:
    - `apps-core/tab-bar`
    - `apps/prototypes/canvas`
    - `apps/website/improve`
    - `primitives/adaptive-bar`
    - `primitives/icon-button`

<!-- AUTOGENERATED:END -->
