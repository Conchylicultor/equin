# Conversations sidebar → DataView migration (high-level plan)

> **Scope.** This is the *global, high-level* migration map. Each phase below is
> meant to be filed as a follow-up task whose own agent will write a detailed
> sub-plan and implement it. Keep this doc as the north star; do not inline
> implementation detail here.

## Context

The conversations sidebar list (the "Conversations" section: **Queue**, **Grouped**,
**History** tabs) is bespoke UI built directly on live-state resources. We already
have an official **DataView** primitive (`plugins/primitives/plugins/data-view/`)
and a working server-delegated DataView of conversations
(`plugins/conversations/plugins/all-conversations/`). The long-term goal is to make
the *sidebar* list a true DataView instance too, so conversations are a first-class
data surface (history + queue + groups) sharing one composable primitive.

The blocker is that the **queue** needs capabilities the primitive does not have yet
(status sections, manual rank ordering on flat views, and collapsing a task-group to
one representative row). The migration therefore does double duty: it adds those
missing capabilities to the DataView primitive *generically*, and it rebuilds the
sidebar on top of them — without ever losing the working view as a fallback.

## End state

- The sidebar conversation list renders entirely through the DataView primitive.
- The old bespoke presentation (`queue`/`grouped`/`history` web components) is deleted.
- The DataView primitive has gained three generic, reusable capabilities:
  **group-by sections**, **flat manual-order**, and **aggregating sections**.

## Core principle: duplicate *presentation*, not data

The hard machinery is presentation-agnostic and **stays exactly where it is**:

- Queue: `conversations_ext_queue` rank, `queue_state` pin singleton,
  `reseatGroupMembers`, `cascadeBlockedDependents`, the `queue-ranks` resource, the
  `/api/conversations-queue/{reorder,promote,demote,step-down,rerank}` endpoints, and
  the seed/pin jobs — all under `conversations-view/plugins/queue/{server,shared}`.
- Groups: `conversation_groups` / `conversation_group_members` tables, the
  `conversation-groups` resource, and the `/api/conversation-groups/*` CRUD — under
  `conversations-view/plugins/grouped/{server,shared}`.
- Conversations active/gone resources from `tasks/tasks-core`; History needs no rank.

Only the **render tree** is duplicated. Both the old and new views read the *same*
resources and call the *same* mutations — which is what makes the fallback
trustworthy by construction (the two cannot diverge in behavior).

**Prerequisite this implies:** the queue/grouped *data layer* (resources +
mutation endpoints + the rank helpers needed client-side, e.g. `applyReorder`) must
be reachable from a new plugin via the plugins' public **barrels**. Where it is
currently private to the bespoke web components, exposing it is part of Phase 0.
Forcing the new view to consume only public barrels also proves the data layer is a
genuinely reusable surface (which it must be for a real DataView instance anyway).

## The switch mechanism: a sidebar `variant-region`

Use the existing `variant-region` primitive (`defineVariantRegion` /
`defineVariantRegionWeb` — the same machinery behind `sidebar-framing` and
`app-rail-framing`) to make the **conversations sidebar body** a switchable region
with two variants:

- `classic` → today's `ConversationsView.Host` (`defineTabbedView`) tabbed view.
- `dataview` → the new DataView-based implementation.

The mount point `conversations-view/web/components/conversation-list.tsx` renders the
**region host**, never either variant by name (collection-consumer separation). The
variant picker is surfaced **in the sidebar itself, next to the conversation list**
(alongside the existing tab switcher) — so the fallback is one visible click away
from where you're looking, persisted via the region's config.

Why this over a `config ? <New/> : <Old/>` at the mount point: a plain conditional
forces the consumer to import *both* hosts, so deleting the old one means editing the
consumer. The variant region keeps the consumer blind to the variant set, so the
**endgame is a pure deletion** — remove the `classic` variant plugin and its
registration, with zero edits to the mount point.

Granularity is **whole-view switch** (one flip swaps all three tabs at once), per the
decision to keep the two paradigms cleanly separated rather than mixing DataView and
bespoke tabs in one bar.

## Primitive gaps to build (generic, in `data-view`)

These are real, reusable additions to the DataView primitive — not conversation hacks.
Each is its own follow-up task and should be designed against the primitive's existing
seams (`ViewState`, `useFlatRows`, the view contributions, `HierarchyConfig`).

1. **Group-by / sections** (Notion's "Group by"). Partition a view's rows by a field
   value (or a key fn) into ordered, collapsible sections with headers + counts; a
   supplied section order (e.g. the status enum order). Resolve centrally and hand
   pre-partitioned sections to list/table/gallery. New `ViewState.groupBy?`.
2. **Flat manual-order**. Lift rank-based DnD out of the tree-only `HierarchyConfig`
   into a flat `manualOrder?: { getRank, onMove }` usable by list/table — factoring
   out the tree's existing `computeDrop` + DnD machinery. Then *queue order within a
   status section* = group-by(status) + manual-order(rank).
3. **Aggregating sections** (confirmed direction for task-groups). A section/grouping
   mode that collapses N rows sharing a key into a single representative row + count
   badge, where acting on the representative acts on the group. This is how task-groups
   (conversations sharing a `taskId`, sharing one rank, moved as one) render. The
   "move as one" server behavior already exists (`reseatGroupMembers` in the queue's
   `onMove` handler); the primitive only needs the visual collapse + representative
   selection.

## What stays consumer-side (queue plugin, via existing seams)

- **Pin** → render as its own pinned section (a group-by bucket) or a sticky row above
  the DataView; `promote`/`demote`/`step-down` endpoints unchanged.
- **Whole-group move + blocked-dependent cascade** → already done server-side in the
  queue's reorder handler; the primitive just calls `onMove(id, { rank })`.
- **Live-state vs server-query**: the **sidebar queue stays on live-state** (bounded
  active set pushed in real time) and feeds `rows={…}` directly. Only **History** uses
  the `server-query`/cursor path (already implemented by `all-conversations`). The
  primitive supports both modes simultaneously — do not force the queue through SQL.

## Mapping the three tabs onto the primitive

- **History** → `list`/`table` view, server-delegated, `ORDER BY created_at DESC` +
  keyset cursor. Closest to `all-conversations` today; lowest risk.
- **Queue** → group-by(status sections) + manual-order(rank within section) +
  aggregating-sections(task-groups) + a pinned section. Live-state rows.
- **Grouped** → genuine 2-level **tree** view (`group → conversations`, both ranked)
  via `HierarchyConfig` with `onMove` wired to the existing group CRUD. The closest
  natural fit to the primitive as it already exists.

## Proposed plugin layout

```
conversations-view/plugins/
  queue/          DATA LAYER STAYS (tables, resources, reorder/pin endpoints, jobs)
  grouped/        DATA LAYER STAYS (group tables, resources, CRUD)
  history/        (trivial)
  classic/        NEW thin wrapper: today's bespoke Host, registered as variant "classic"  [deleted at end]
  data-view/      NEW: DataView-based UI, registered as variant "dataview"
  sidebar-region/ NEW: defineVariantRegion for the sidebar body + the in-sidebar picker
```

`data-view/` consumes the `queue`/`grouped`/`history`/`tasks-core` barrels for
resources + mutation endpoints. (An umbrella with per-tab sub-plugins is an option if
each tab grows large; can start as one plugin.)

## Phased migration (each = a follow-up task to plan + implement)

- **Phase 0 — Scaffold the switch + expose the data layer.** Build
  `sidebar-region/` (`defineVariantRegion` + in-sidebar picker), move today's Host
  into `classic/` as the first variant, and export the queue/grouped resources +
  endpoints + client rank helpers from their barrels. Net behavior unchanged; the
  toggle exists with a single variant.
- **Phase 1 — History as a DataView.** First `dataview` variant content: a
  server-delegated History list reusing `all-conversations` infra. Ships value,
  near-zero risk, validates the variant pipeline end-to-end.
- **Phase 2 — Primitive capabilities.** Build group-by sections, flat manual-order,
  and aggregating sections into `data-view` generically (three sub-tasks). No
  conversation coupling.
- **Phase 3 — Queue (+ Grouped) as DataView.** Compose the queue from the Phase 2
  primitives + consumer pin/task-group `onMove`; build Grouped as a tree view. Reach
  parity behind the `dataview` variant.
- **Phase 4 — Cutover + delete.** Make `dataview` the default variant; once trusted,
  delete `classic/` and collapse the region (or mount the new host directly). Pure
  deletion — no mount-point edits.

## Critical files / reference points

- Mount point: `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- Sidebar section + tabbed host: `…/conversations-view/web/components/conversations-sidebar.tsx`, `…/web/slots.ts` (`ConversationsView` = `defineTabbedView`)
- Queue data layer: `…/conversations-view/plugins/queue/{server/internal,shared/resources.ts,web/components/apply-reorder.ts}`
- Grouped data layer: `…/conversations-view/plugins/grouped/{server/internal,shared}`
- History: `…/conversations-view/plugins/history/web/…/history-view.tsx`
- DataView precedent: `plugins/conversations/plugins/all-conversations/` (fields, server-delegated source, revision-tick resource)
- DataView primitive: `plugins/primitives/plugins/data-view/` (+ `view-core`, `server-query`, `tree`, `list`)
- Switch primitive: `plugins/ui/plugins/variant-region/`
- Rank primitive: `plugins/primitives/plugins/rank/`

## Verification (high-level; each phase defines its own)

- After Phase 0: `./equin build`, open `http://<worktree>.localhost:9000`, confirm
  the sidebar is pixel-identical and the variant picker appears with one option.
- After each `dataview`-tab phase: with the toggle, switch classic↔dataview live and
  confirm identical data + working mutations (drag-reorder, promote/demote, group
  create/join, pin advance) against the same DB — driven via `e2e/screenshot.mjs`
  (click the picker / drag rows, capture before/after).
- Cross-check the DB with the `query_db` MCP tool (e.g. `conversations_ext_queue`,
  `conversation_group_members`) to confirm both views write identical rank/group rows.
- Phase 4: confirm no remaining imports of the `classic` variant before deletion
  (`./equin check plugin-boundaries`, `plugins-registry-in-sync`).
```
