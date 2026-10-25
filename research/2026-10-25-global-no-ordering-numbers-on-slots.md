# Ordering is never a number on a slot contribution

## Context

`HealthReport.Row` was made a plain `defineSlot` with hand-picked `order:` numbers
(0/5/10/20/30/40, with collisions), on the premise that a render slot "owes a reorder
config for nothing". It copied `DataViewSlots.Control` / `Setting`, which made the same
argument. The user's decision: a contribution never carries a position number. What is
drawn is a `defineRenderSlot` (or `defineOrderedDispatchSlot`) and its order is the slot's
reorder config layout (`config/<plugin>/<slotId>.jsonc`, seeded by `./equin build`); a host
that draws its own rows reads that order with slot-render's `useSlotOrder(slot)` — backed by
a `SlotRender.Order` companion reorder's slot-middleware contributes beside its list
middleware, so hosts never name reorder — and draws each row through `renderAsContribution`
(the item middlewares: isolation, lineage). A plain `defineSlot` is data read as
data. A number that is not a visual position is renamed after what it means.

## Survey (tsc, with the constraint switched on)

| Slot | Key | What the number is | Action |
|---|---|---|---|
| `shell/health-report` `HealthReport.Row` | `order` | popover row order | render slot + `useReorderedEntries`; info-first and quiet-fold stay host arrangement |
| `apps-core/surface` `Surface.Placement` | `order` | Layout control option order; fallback default | render slot + layout; fallback = first in layout (`default: true` stays the boot mode) |
| `sonata/progress/scrubber` `Label`, `Describe` | `order` | contributor order inside a same-beat group / preview line | render slots + layout (it is contributor order, not a property of a label) |
| `primitives/data-view` `Control`, `Setting` | `order` | toolbar / settings-menu reading order | render slots; host keeps building triggers from metadata, ordered by `useReorderedEntries` (no `.Render`, so no panel mounts) |
| `primitives/data-view` `View` (`ViewTypeMeta.order`) | `order` | view-type menu order | render slot (gains keyed `companions`), id derived from `type` via `defineSlotFacade` |
| `primitives/data-view` `RowOrder` (render slot) | `order?` | unused | delete the field |
| `primitives/tabbed-view` `TabContribution` | `order?` | tab order (factory has no caller) | render slot + layout read |
| `primitives/inline-text` walker, `primitives/markdown` enhancer | `order` | processing stage: which walker sees the text first | **rename** `stage` — a pipeline, not painted rows; a user layout must not be able to reorder it |
| `primitives/markdown` `Markdown.Extension` | `priority?` | no contributor, no reader | delete the field |
| `primitives/shortcuts` `Shortcut` | `priority?` | which of two eligible handlers for one keystroke wins | **rename** `precedence` |
| `primitives/slot-render` `ListMiddleware`, `ItemMiddleware` | `priority` | wrapping depth (lowest outermost) | **rename** `depth` |

Left alone (not web plain slots): server `TaskCategory.order`, `liveArm({ order })` (core
data on a union arm, not a slot contribution). Former `Runs.Kind` no longer exists.

## The constraint

`defineSlot<P extends NoOrderingNumber<P>>` on both overloads
(`plugins/framework/plugins/web-sdk/core/slots.ts`): a conditional, distributed over union
members, mapping any `order|priority|rank|weight` key whose value (minus `undefined`) can
be a number to a string-literal type spelling the alternative. Proven by a
`@ts-expect-error` test. slot-render's four generic funnel calls (`P & {...}` with a naked
`P`, which tsc cannot resolve) go through one documented internal alias.

## Health report

- `HealthReport.Row: defineRenderSlot<HealthReportRow>`; panel and probes read
  `useReorderedEntries(HealthReport.Row.id, rows)`; `sortRows` keeps only "info first"
  (stable over layout order) and `foldQuietRows` is unchanged.
- Each row is drawn inside slot-render's item middlewares (`renderIsolated`-equivalent box)
  so `[data-lineage="contribution"]` reaches it.
- The dot becomes a contribution: the button is contributed to the action-bar slot from
  `shell/health-report` (one mount per host, leading item), so a pick on it names the plugin.
- Seeded layout: worktree-identity, claude-code, connection, job-queue, database,
  machine-watcher, live-reads, browser-storage, gateway, agent-browser (verified against
  today's numbers + registration order).

## Docs

web-sdk `CLAUDE.md` (rule under the `defineSlot` intro; drop `order` from the readable-field
example), slot-render `CLAUDE.md` bullet, reorder `CLAUDE.md` line, root `CLAUDE.md` Coding
Style sentence, health-report `CLAUDE.md` + `research/2026-09-10-global-unified-health-report.md`.

## Verification

`./equin test` on every touched plugin; `./equin build` (seeds the new layouts — arrange,
drop `// @review`); browser: health popover order + lineage, data-view toolbar/settings
order, markdown/inline-text on a conversation.
