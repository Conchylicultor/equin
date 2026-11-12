# User-made sections in the Agent Manager sidebar

## Context

The conversations sidebar groups the Queue source into fixed sections (Pinned, Queue,
Working, …) through a synthetic `section` enum field
(`conversations-view/plugins/data-view/plugins/queue/web/components/queue-fields.ts`).
The user wants to make their own sections and drag conversations between them,
keeping today's "rows slide out of the way while I drag" feel, now across sections
too. UI explored in prototype `proto-1794436925-nx8tf1`:

- drag a row onto a floating **"+ New section"** target (it overlays the list's
  bottom edge: no layout shift) → the section is created holding the row, name field
  focused and selected;
- row ⋯ **Move to** menu: every section, Queue, **New section…**;
- header hover **+** (add an empty section below), header ⋯ (Rename, Move up/down,
  Delete → members back to Queue), double-click name to rename, click to collapse;
- drag a section by its header to reorder sections.

Decisions (user, 2026-11-12):

1. A section holds **waiting** groups only. A working group shows under Working, exactly
   as Pinned does today (`classify-queue.ts`).
2. **Pinned stays built-in**: fixed first, not deletable/renamable/draggable; Pin/Unpin
   keeps working and means "move to Pinned / back to Queue". User sections sit between
   Pinned and Queue.
3. **Section header drag is in v1.**

## Data model (queue plugin, `conversations-view/plugins/queue`)

- New table `conversation_sections` (`server/internal/tables.ts`): `id` (new id kind
  `csec`, registered beside the queue's), `name`, `rank` (`rankField()`), `createdAt`.
  Served as `queueSections = liveCollection("queue-sections", …)` ordered by rank;
  bounded `default.limit: 200` / `maxLimit: 200` (a user's own sections), boot-preloaded
  like `queueRanks` so the sidebar never paints without them.
- `queueShape` (`core/resources.ts`): replace `pinned: boolField()` with
  `section: <nullable text>` — `"pinned"` (reserved key, `PINNED_SECTION` in core), a
  `csec-…` id, or `null` (= Queue). One spelling for membership; no second flag.
  Phased migration: expand (add `section`), claimed data migration
  (`section = 'pinned' WHERE pinned`), contract (drop `pinned`) — grammar in
  `research/2026-09-29-global-phased-migrations.md`. `./equin build` generates it.
- `setGroupPinned` → `setGroupSection(conversationId, section, tx)` (writes every live
  group member, same rule as today).
- Ranks stay ONE global rank space. A section's order is that space filtered, so
  `rankAdjacentTo(target, zone)` is already correct across sections, and "move to a
  section" keeps the row's rank (it lands at its natural place among that section's
  members).

### Endpoints (`core/endpoints.ts`, handlers `server/internal/handle-*.ts`)

| Endpoint | Body | Effect (one tx, `lockDeck`) |
|---|---|---|
| `pin` → **`file`** | `{ conversationId, section: string \| null }` | seed rank if unranked (today's pin path), `setGroupSection` |
| `reorder` | `+ section?: string \| null` | as today; when `section` is present also `setGroupSection` (a cross-section drop) |
| `sections/create` | `{ name, after?: sectionId \| "pinned", conversationId? }` | insert section ranked after `after` (else last); file `conversationId`'s group into it; returns `{ id }` |
| `sections/rename` | `{ id, name }` | trimmed, non-empty (400 otherwise) |
| `sections/move` | `{ id, targetId, zone }` | rank adjacent among sections |
| `sections/delete` | `{ id }` | set members' `section = null`, delete row |

`file`/`reorder` reject an unknown section id (404) — never a dangling reference.

## Primitive changes (`primitives/rank-reorder`, `primitives/data-view`)

All generic; nothing names conversations.

1. **Live cross-group sliding** (rank-reorder; today "future work" in its CLAUDE.md).
   With `onReseat`, `onDragOver` into another group sets a *drag preview*
   `{ id, group, targetId, zone }` (multi-container sortable pattern). The provider
   publishes it (render-prop / context); the list view applies it to its sections
   (`applyDragPreview`: move the entry, fix both counts), so the row is laid out in its
   new section and that section's rows slide around it with the normal
   `verticalListSortingStrategy`. Drop → `onReseat` with the preview's anchor;
   `usePendingMoveOverlay` extends to hold the row **in the target section** until the
   row's section key changes (or the promise rejects) — no snap-back.
2. **Drop into a group with no anchor**: each section header (and an empty section's
   body) is a droppable; `ManualOrderConfig.onReseat` dest becomes
   `{ groupKey, targetId?, zone? }` — absent anchor = "into the group" (consumer keeps the
   rank). Covers empty and collapsed sections.
3. **New-group target**: `ManualOrderConfig.onReseatNew?: { label; onDrop(id) }`. While a
   row drag is in flight the list draws a droppable over the bottom of its scroller:
   a zero-height `sticky bottom-0` anchor holding an absolutely positioned card, so it
   takes no layout space (prototype look: dashed → solid accent when over).
4. **Empty sections are drawn**: `FieldOption.alwaysGroup?: true` — the enum grouping
   emits that option's bucket even with no rows (header + empty band). Generic; default
   off.
5. **Section editing**: `DataViewProps.groupEdit?: GroupEditConfig`
   `{ editable(key): boolean; onRename(key, name); onMove(key, { targetKey, zone });
   renaming: key | null; setRenaming(key | null) }` — editable headers get inline
   rename (double-click or `setRenaming`), and are drag sources in a **second
   SortableContext under the same DndContext** (section blocks slide live, reorder only
   among editable sections; non-editable ones are fixed). Delete / + / Move up-down stay
   consumer `headerActions`.

Tests beside each: `resolve-sortable-drop` / preview logic (bun), list-view jsdom tests for
cross-group preview, anchorless drop, new-group target, alwaysGroup, header rename + move.
Update `rank-reorder/CLAUDE.md` and data-view `CLAUDE.md` (Manual order, Grouped sections).

## Sidebar consumer (`conversations-view/plugins/data-view/plugins/queue`)

- `useQueueRows` reads `queueSections`; `classifyQueue` sorts waiting groups by
  `selected.section` (`"pinned"` / user id / `null`→`queued`); unknown id → `queued`.
- `QUEUE_EXTRA_FIELDS` becomes `useQueueFields(sections)` (memoized): options
  `pinned`, …user sections (rank order, `alwaysGroup: true`), `queued`, `working`, ….
- `manualOrder`: `onMove` as today; **`onReseat`** → `reorder` with `section` (or `file`
  when anchorless); **`onReseatNew`** → `sections/create { conversationId }`, then
  `setRenaming(newId)`. Only `pinned` / `queued` / user sections are ranked, so other
  sections stay neither source nor target.
- `groupEdit`: `editable = isUserSection`; rename/move → endpoints.
- `headerActions`: user section → `+` (create after it) and ⋯ menu (Rename, Move up,
  Move down, Delete · N back to Queue); Queue → `+` (create last).
- Item action **Move to** (`queue-item-actions.tsx`): dropdown — Pinned, user sections,
  Queue (current one checked/disabled), separator, New section…. `PinAction` calls `file`.
- Drop the "No `onReseat` on purpose" comment; update the queue plugins' CLAUDE.md.

## Execution (parallel agents)

1. **Primitives** (Opus, worktree-shared): rank-reorder + data-view items 1–5 with tests.
2. **Queue server** (Sonnet): table, id kind, collection, migration, endpoints, classify
   change, server tests.
3. **Sidebar consumer** (Opus), after 1 + 2 land: wiring above, Move to menu, header
   actions, e2e extension of `e2e/queue-reorder.ts` (cross-section drop, new-section
   target, header drag).

The contracts above (endpoint bodies, `ManualOrderConfig` / `GroupEditConfig` /
`FieldOption.alwaysGroup`) are fixed so 1 and 2 run concurrently.

## Verification

- `./equin check`, `./equin test plugins/primitives/plugins/rank-reorder
  plugins/primitives/plugins/data-view plugins/conversations/plugins/conversations-view`.
- `./equin build`, then drive the sidebar with `browser_*` and the queue e2e script:
  drag a Queue row into Pinned and back (rows slide in both sections), onto "+ New
  section" (no layout shift; section created, name focused), into an empty section,
  reorder sections by header, rename, delete (members return to Queue), Move to menu.
- Migration: existing pinned conversations appear under Pinned after the build.
