# motion

How floating surfaces move — by default, so nobody has to remember to animate
one. Five mechanisms, each owned where it can be automatic:

| Moment | Who owns it | How |
|---|---|---|
| **Enter** | the surface | `Surface` levels `overlay` / `float` wear `surface-enter` (ui-kit `app.css`): a fade and scale from the overlay token group (`--overlay-enter-duration` / `-easing` / `-scale`). Never `translate` — `Pin` / `Placed` centre with it. Popovers (`OverlayPanel`) keep their own `overlay-enter`. |
| **Size** | the surface | `useSizeMotion` (attached by `Surface` overlay / float): when the surface's **content** changes its size — a card becoming a pill, a list drilling into a detail, a thread growing — it tweens width / height / corner radius instead of jumping. |
| **Arrive** | `<Arrival>` | A row added to a flow of rows while the reader watches (a transcript line written live, a block another writer added to an open page) eases in: its slot opens from zero height while the row fades in, so the rows after it glide instead of jumping. In-flow, unlike Enter. |
| **In-flow change** | the container | `useFlowMotion` (attached by `detail-sections`' `SectionStack` and the `data-view` icons grid): when the SET of a container's laid-out children changes — a section shown, a tile added, one removed or moved — a new child fades and scales in and every displaced sibling glides from its old place (FLIP). |
| **Exit** | `<Presence>` | A surface cannot animate its own unmount, so the conditional goes inside `<Presence>`, which keeps the leaving element drawn until its exit has run. Popovers exit by themselves (`OverlayPanel`'s `data-ending-style:overlay-exit`; base-ui waits for it). |

`Surface motion={false}` opts a surface out of enter and size motion, for one
whose geometry something else already animates.

## `<Presence>`

```tsx
<Presence>
  {open ? <Pin key="card" to="right" layer="float">…</Pin> : null}
</Presence>
```

- **One keyed child** (or nothing). Its identity is its `key` and type: a new
  key is a different surface — the old one leaves while the new one enters,
  a cross-fade in place (the Places floating card swapping places).
- The child must **forward `ref` to its root DOM element** (`Pin`, `Placed`,
  `Surface`, `Layer`, `Stack`, `Column` … all do). One that doesn't throws as
  it first leaves or enters.
- **Leaving**: the same instance (its state intact) is made `inert`,
  `aria-hidden` and click-through, taken out of the flow at its last box (so
  what replaces it, or the siblings after it, never jump), and fades with the
  token scale in three quarters of the enter's time; then it is dropped. Its
  caller `ref` is released as it starts leaving, so a ref never names a ghost.
- **Entering** (not on the first render): nothing if the child already
  animates its arrival (a `Surface` does), else the same fade-and-scale in.
- The same key coming back mid-exit cancels the exit (same instance). To get
  a fresh instance on every opening, key each opening (`launcher-overlay.tsx`).
- No retention under reduced motion, nor where the overlay duration is `0`
  (or unset — a jsdom test): the child goes in the same render, exactly like
  a bare conditional, so synchronous tests keep working.

## `useSizeMotion`

`useSizeMotion(ref, enabled)` watches the element `ref` holds:

- A `MutationObserver` (after the commit, before the frame's layout) measures
  the new box and starts the tween there, so the first frame drawn is already
  the old size. The `ResizeObserver` only records the resting box: it never
  resizes the element it was just handed — a tween started from the size
  report raised "ResizeObserver loop completed with undelivered
  notifications" on every grow / shrink. A window resize or a parent's
  re-layout lands at once.
- Only the dimensions that changed animate, from the last resting box, over
  240 ms on the hints/dock glide curve; a box with `overflow: visible` is
  clipped meanwhile.
- While something inside already animates layout (a `FoldMotion` fold, a row
  glide), it does not tween — the surface follows the inner motion.
- Never from or to an empty box; never under reduced motion.

## `<Arrival>`

```tsx
<Arrival key={row.id} arrived={isNewSinceOpen(row)}>
  <MyRow row={row} />
</Arrival>
```

- **`arrived` is the caller's judgement, read at mount only.** The primitive
  cannot tell a row written by someone else from the initial load or from one
  the user just created — the list owner can, so it says so. A later render
  saying `arrived` never starts an entry.
- The wrapper is always rendered (the entry ending never remounts the row); it
  is a plain block at rest. 180 ms: `grid-template-rows` 0fr → 1fr on the
  wrapper (clipping the row meanwhile), opacity 0 → 1 on the row.
- While entering it carries `FOLLOW_MOTION_ATTR` (`dom/auto-scroll`), so a
  stick-to-bottom surface glides with the opening.
- Never under reduced motion.
## `useFlowMotion`

`useFlowMotion(ref, enabled)` watches the children of the element `ref` holds:

- Its **items** are the boxes the container lays out — its children, seen
  through `display: contents` wrappers (a render slot's item box), skipping
  `display: none` and absolutely / fixed positioned ones.
- Only a child added, removed or moved directly under the container or one of
  those wrappers is a change; a mutation deeper inside an item never
  re-measures anything (a playing transcript costs nothing).
- On a change (the `MutationObserver`, after the commit, before the frame's
  layout): an item with no recorded position **enters** — the overlay token
  group's fade and scale, `Presence`'s enter; every other item whose position
  moved **glides** from its last recorded one over 240 ms on the size-motion
  curve. Glides animate `translate` additively, so a change mid-glide carries
  on from where the item is drawn.
- Positions are recorded transform-free, container-relative, at each change and
  on every size report of the container or an item (a section opening, a window
  resize) — which never animates.
- A leaving item just goes (its neighbours glide into its place); wrap it in
  `Presence` for an exit. Nothing moves on the first attach, nor under reduced
  motion. Turn it off where something else moves the same items (a drag:
  the icons grid passes `false` while a tile is dragged).
- `<Arrival>` vs `useFlowMotion`: Arrival wraps ONE row whose arrival only
  the list owner can judge (written live vs the initial load), and opens its
  slot by height; `useFlowMotion` is the container's, for any child set change
  (shown, hidden, added, moved), and moves the siblings by FLIP.

## Lint: `motion/no-unanimated-surface-exit`

Flags a floating surface — `Pin` / `Placed` / `Layer` with `layer="float"` or
`"overlay"`, `Surface` with `level="overlay"` or `"float"`, `ViewportOverlay` —
mounted by a bare conditional (`x && <…>`, `x ? <…> : null`) that is not the
direct child of `<Presence>`. A composite child (`{open && <PlaceCard/>}`) is an
accepted false negative: its surface still enters and resizes with motion.
Genuine exceptions are declared in the owning plugin's `exempt/index.ts`.

## Not here

`FoldMotion` / row-fold (content folding inside a box that stays), miller's
`ColumnMotion`, `FloatingAction`'s hover morph, the hints stage and the sonata
dock each own their motion. `prefersReducedMotion` lives here for all of them.
Design: [`research/2026-10-25-global-surface-motion.md`](../../../../../../research/2026-10-25-global-surface-motion.md).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: How floating surfaces move: <Presence> keeps a leaving surface drawn until its exit has run (and cross-fades a keyed swap), useSizeMotion tweens a surface's size when its content changes, useFlowMotion fades a newly shown in-flow item in and glides the siblings it displaces, prefersReducedMotion, <Arrival> eases a row that arrives while the reader watches into a flow of rows (slot opens, row fades in) — plus the no-unanimated-surface-exit lint rule.
- Web:
  - Uses:
    - `primitives/dom/auto-scroll.FOLLOW_MOTION_ATTR`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/element-size.useResizeObserverSet`
  - Exports (types):
    - `ArrivalProps`
    - `PresenceChild`
    - `PresenceProps`
  - Exports (values):
    - `Arrival`
    - `prefersReducedMotion`
    - `Presence`
    - `useFlowMotion`
    - `useSizeMotion`
- Cross-plugin:
  - Imported by:
    - `apps-core/pane-morph`
    - `apps/desktop/launcher`
    - `apps/places/places-map`
    - `apps/sonata/library`
    - `conversations/conversation-view/jsonl-viewer`
    - `hints/ask`
    - `layouts/miller`
    - `map`
    - `page/editor`
    - `page/place`
    - `primitives/collapsible`
    - `primitives/collapsible-wrap`
    - `primitives/css/surface`
    - `primitives/data-view/icons`
    - `primitives/detail-sections`
    - `primitives/overlay/image-viewer`
    - `primitives/virtual-rows/row-fold`

<!-- AUTOGENERATED:END -->
