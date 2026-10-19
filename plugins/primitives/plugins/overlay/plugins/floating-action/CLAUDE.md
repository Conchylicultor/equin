# floating-action

## The `trigger` slot (required)

`FloatingAction` takes a **required `trigger`** prop — the rigid, always-visible
*collapsed footprint*: the element shown while the panel is closed (the trigger
icon / glyph / header row). The primitive renders it in its own
never-flex-shrink wrapper, as the first flex child of the morph panel, so the
trigger **can never collapse to 0** even when `children` are a tall or wide flex
sibling under a clamped panel (`max-h-*` / `max-w-*`). This makes "the trigger
vanished" structurally unrepresentable — the bug class the `Frame`/`Badge`
primitives exist to eliminate.

The primitive **owns the `shrink-0`** on the trigger wrapper, so consumers
declare *which element is the trigger* (the role) and never reach for the
lint-banned `shrink-0` mechanic themselves.

The expanding content goes in **`children`**, wrapped in `FloatingActionFadeIn`
so it fades in on open.

## The panel's layout is props, its size is a class

The panel is the primitive's flex box, so its flow is stated as roles it owns:
`direction` (`row` | `col`), `triggerAt` (`start` | `end`), `align`, `gap` from
the spacing ramp, and `pad` — the popover's own padding role. `triggerAt="end"` is the reversal: the trigger is
always the first DOM child, and reversing also flips where a clamped panel packs
its items — which is what keeps the trigger flush against a bottom-anchored
panel's bottom edge while the content is revealed above it. Stating that as
`flex-col-reverse` at the call site couples the caller to DOM order it does not
own.

`panelClassName` is **sizing only** — the collapsed→open morph (`max-w-*` /
`max-h-*` / `w-*`), which the primitive animates but cannot size, because the
open extent is a per-call-site measurement. It is typed `ClassName`, so its value
comes out of `cn()` and `no-adhoc-layout` reads its tokens: a layout class
written there is a lint error, not a silent override.

## The panel IS the popover panel

The morphing panel renders ui-kit's `OverlayPanel` — the one panel every
popover, menu, select and floating surface renders — with `scroll={false}` (it
owns its overflow: it clips its own morph). So the open panel wears the theme's
overlay surface (`--popover`, `--popover-border` ring, `rounded-popover`,
`shadow-popover`) and its padding rail, and cannot drift from a popover's look.
Collapsed, the `variant` lays its resting look over that paint (`ghost`:
nothing; `outlined`: a translucent chip); open, the popover paint is the whole
look, and the transition animates between the two. `glass` is the exception:
it is its own surface (below), laid over the popover paint in both states.

A host that itself floats (a `FloatingSurface` toolbar) must not clip the panel
morphing out of it: it passes `scroll={false}` too.

## The `glass` variant and the `pill` shape

`variant="glass"` is a frosted capsule, identical collapsed and open, made of
translucent mixes because it floats over whatever app is behind it: the
background at 72% under an 18px 1.6× saturated blur, a 1px ring of the
foreground at 9% plus a 4% top highlight, and the theme's `shadow-2xl`. It is
its own surface, so it re-publishes `--hover-fill` (the foreground at 8% —
translucent, so a hover never paints an opaque patch on a light app showing
through) and `--chrome-mask` (its ground, for cut-out rings such as a badge's).

`shape="pill"` rounds the panel fully and sets every control radius role
(`--radius-control`, `--radius-control-sm`, `--radius-control-xs`) to full
inside it, so every control in the capsule is a pill too, whatever its size.

## A popup opened inside holds the panel open

A popover, menu or select opened from the panel's content is drawn outside the
panel's box, so moving the pointer to it reads as leaving the control (and
focusing it as a blur). `FloatingAction` is a `PopupOpenScope`: while any popup
opened inside it is open, the panel stays open, and Escape and presses belong
to that popup — closing it does not take the panel along. First consumer: the
prototypes options picker's version list.

## Hover is the DOM box, focus is the keyboard

Hover is read from native `pointerenter` / `pointerleave` on the wrapper, plus
a document `pointermove` containment check while hovered — never React's
synthetic enter/leave. Those follow the React tree, so a portaled overlay opened
from inside (the element picker, a popover) counts as inside, and when it
unmounts under the cursor React fires no leave at all: the panel stayed open,
covering what was behind it. Focus opens the panel only when it is
`:focus-visible` (keyboard), since a clicked button keeps focus and would
otherwise pin the panel open after the pointer left. `:focus-visible` is not
proof of a Tab, though: a popover closed after any key (typing in it, Escape,
a submit shortcut) restores focus to its trigger and Chrome marks it visible.
So the pointer outranks focus — a pointer leaving, or moving anywhere outside
the control, ends a focus open just as it ends a hover open; the next keyboard
focus (a Tab) reopens it. jsdom does not model `:focus-visible`, so the
global action bar's `e2e/focus-restore.ts` checks this in Chromium.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Disclosure-intent floating action: a single morphing panel revealed by hover, focus, or touch via the useDisclosureIntent state machine (grace-delay close, no re-entry dead zone, Esc/outside-press dismiss), over a stable hover hitbox that cures open/close flicker.
- Web:
  - Uses:
    - `primitives/css/spacing.StackAlign`
    - `primitives/css/spacing.StackDirection`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.OverlayPanel`
    - `primitives/css/ui-kit.PopoverPadding`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/overlay/popup-open.PopupOpenScope`
  - Exports (types):
    - `FloatingActionFadeInProps`
    - `FloatingActionProps`
    - `FloatingActionTriggerAt`
    - `FloatingAnchor`
  - Exports (values):
    - `FloatingAction`
    - `FloatingActionFadeIn`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/material --popover-backdrop`
    - `ui/tokens/material --popover-fill`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shadow --shadow-2xl`
    - `ui/tokens/shadow --shadow-sm`
  - Imported by:
    - `apps/sonata/track-mixer`
    - `conversations/conversation-view/prompt-templates`
    - `primitives/outline/rail`
    - `shell/global-action-bar`
- Exemptions:
  - Exempts itself from: `layout/no-adhoc-layout` — `web/internal/floating-action.tsx` (sanctioned)

<!-- AUTOGENERATED:END -->
