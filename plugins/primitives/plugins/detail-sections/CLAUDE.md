# detail-sections

A detail pane is **one render slot whose sections are contributions**.
`defineDetailSections("<id>")` → `{ Section, Host, SectionItem, SectionStack }`.
The host paints every section as a [`SectionCard`](../section-card/CLAUDE.md), so
a section never paints its own card, title, or chevron. `actions` + `summary`
share the header-right slot (both stay visible while collapsed).

## Chrome: one closed choice, made by the slot OWNER

`defineDetailSections({ chrome: "card" | "inspector" })` (default `card`) picks
which of `SectionCard`'s two variants EVERY section of the pane wears — never a
section's choice. `card`: bordered cards, leading chevron, `gap-sm` stack inside
the `inset` (default `lg`). `inspector`: flat sections divided by a bottom rule,
full-width headers (collapsed title muted, an open section's icon in the primary
colour, a quiet chevron at the row's far end), no gap, no inset — and `inset`
is type-rejected on that arm. Beside a collapsible inspector section's title
sits ONE thing: its `summary` while shut, its `actions` once open (either alone
when it declares only one). `SectionStack` is the stack that owns this
rhythm; `Host` uses it, and a multi-zone pane wraps its `SectionItem` zones in it
instead of hand-setting a gap or padding. Sonata's player column is the
inspector pane.

**There is no chrome opt-out**, not even for a pane's identity block — the
entity's name lives in the pane header, so a collapsed identity card loses
nothing, and an opt-out reads as "this panel doesn't want your card" to the next
author. Nothing to show ⇒ `useAvailable`; start expanded ⇒ `useDefaultOpen`.

## One line ⇒ no `component`

Declare `component` and you get a collapsible card. **Omit it** — content rides
the header as `summary` (a path, a count, chips) and/or `actions` (a select, a
button) — and the card is one static row: no chevron, no open state. The chevron
is derived from the body's presence, so it can never open onto one select.
`useDefaultOpen` is type-rejected there: it describes a body.

## Empty ⇒ `useAvailable`, never `return null`

The host paints the card *before* the body and can't see that the body produced
nothing — a `return null` (or a lone "No X." placeholder) leaves a titled bar
over emptiness. Two recurring calls:

- **Loading ≠ empty.** Return `true` while the resource is pending, or the card
  pops in a frame late; let the body show its own `<Loading/>`.
- **Header `actions` ≠ empty.** They're how the user fills it —
  `task-dependencies` keeps its card at zero deps, its action-less `Dependents`
  peer hides.

## More than one zone: `SectionItem`

`Host` is one `SectionStack` over one `.Render`. A pane whose sections split
across several zones (Sonata's column: an `editor` zone above a `player` zone)
lays them out itself inside `SectionStack` and paints each one with `SectionItem`
— the same chrome and rhythm, so it still can't drift. Caller-defined contribution fields that drive such a split ride on
the second type param, `defineDetailSections<Props, Extra>`; they widen the
contribution type only. Such splits are render-time filters: `subId` does **not**
partition reorder (layout is keyed by the base slot id), so all zones share one
order.

## Open state

**persisted toggle → `useDefaultOpen?.(props)` → `false`**, persisted per device
via `useDraft` under `` `<slotId>.<sectionId>.open` `` (e.g.
`sonata.section.chord-readout.open`). `useSectionOpen(sectionId)` (on the
factory's return) reads and writes that same value from outside the card — a
rail of section icons opening the one picked. `useDefaultOpen` only *seeds* it — resolved
once per mount, so a later flip never yanks a card the user has touched.

## A collapsed body is genuinely UNMOUNTED

`CollapsibleContent` renders `null` while collapsed, so a heavy panel costs
nothing until opened. The corollary is a trap: work that must outlive the panel
(debounced persistence, a subscription, a sync observer) does **not** belong in
the body — lift it into a headless `defineMountSlot` contribution on the owning
pane. For the same reason a section cannot opt out with `return null`; declare
`useAvailable` instead (a false gate paints nothing at all).

## Slot id (load-bearing)

The emitted slot id is `` `${id}.section` `` verbatim, and
`reorderDirectiveDescriptor` uses a slot id verbatim as its config_v2 config name
(`config/<plugin>/<slotId>.jsonc`). Renaming a slot silently resets every user's
persisted section order — pick factory ids that reproduce the existing string.

## The rail

`SectionStack` (and so `Host`) **opens the region** — `railClass({ rail: inset })`, which pads and
publishes the same step in one declaration. Do not put `insetClass` back: it pads
without publishing, so the stack would inset its sections by a number none of
them could read.

Nothing wraps a section body any more: `SectionCard` opens its own region, so a
DataView dropped in is inset once, by the card. See `data-view/CLAUDE.md`
("The rail").

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Factory for extensible detail-view section slots with built-in Reorder DnD.
- Web:
  - Uses:
    - `primitives/css/inline.Inline`
    - `primitives/css/spacing.Stack`
    - `primitives/persistent-draft.useDraft`
    - `primitives/section-card.SectionCard`
    - `primitives/slot-render.defineRenderSlot`
    - `primitives/slot-render.RenderSlot`
    - `ui/icons.Icon`
  - Exports (types):
    - `DetailSection`
    - `DetailSections`
    - `DetailSectionsOptions`
  - Exports (values): `defineDetailSections`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/deployments`
    - `apps/deploy/servers`
    - `apps/events/sources`
    - `apps/events/sources/source-detail/runs`
    - `apps/pages/page-tree`
    - `apps/sonata/shell`
    - `apps/studio/compositions`
    - `apps/studio/compositions/release`
    - `apps/studio/contributions/tables`
    - `backup`
    - `build`
    - `plugin-meta/plugin-view`
    - `review`
    - `tasks/task-detail`
    - `ui/theme-engine/theme-customizer`

<!-- AUTOGENERATED:END -->
