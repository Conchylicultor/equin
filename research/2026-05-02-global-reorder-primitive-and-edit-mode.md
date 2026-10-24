# Global Reorder Primitive + Edit Mode

## Context

The app's surfaces — top toolbar, sidebar items, conversation bars — present plugin-contributed buttons in plugin-registration order. Users can't customize that order. We want a generic reorder mechanism that:

1. Owns lexical ranks for any slot's contributions (no per-plugin reinvention).
2. Toggles into a global iOS-style "edit mode" via a pen button on the top toolbar — items shake, become drag-droppable, click is suppressed.
3. Persists the user's chosen order in the **per-worktree server's Postgres**. Worktrees fork main's DB on creation, so a user's customizations on the main namespace propagate naturally into new worktrees; agent worktrees can locally adjust without polluting main.
4. Is a one-token opt-in for the slot owner: mark a slot reorderable, every host that renders it gets the behavior with one hook call.

Target surfaces (all migrated in v1): `Shell.Toolbar`, `Shell.Sidebar` (three structurally distinct sub-lists), `Conversation.ActionBar`, `Conversation.AbovePromptInput`, `Conversation.PromptBar`. Drag is **within-group only** in v1.

## Architectural Decisions

### 1. The slot owner opts in via `Reorder.area(slot, opts?)`

Dependency direction: **slot owner → reorder primitive**, never the reverse. `plugin-core` is untouched; the reorder plugin has zero awareness of which slots use it.

The reorder plugin exports a wrapper:

```ts
// @plugins/reorder/web — public API
export const Reorder = {
  area:    <P>(slot: Slot<P>, opts?: ReorderConfig<P>) => ReorderableSlot<P>,
  useArea: <P>(slot: ReorderableSlot<P>, override?: HostOverride<P>) => UseAreaResult<P>,
};
```

`Reorder.area(slot, opts)`:
- registers `{ slot.id, opts }` in the reorder plugin's internal `Map<slotId, ReorderConfig>` (synchronous side effect at module-load)
- returns the same slot, type-tagged as `ReorderableSlot<P & { id: string; excludeFromReorder?: boolean }>`

The slot owner calls it once in their `slots.ts`. The reorder plugin never imports a consumer.

### 2. `id` and `excludeFromReorder` are added to the slot's prop type by `Reorder.area`

Slot owners do **not** add `id: string` themselves — the wrapper enriches the prop type:

```ts
// Conceptual signature
function area<P>(slot: Slot<P>, opts?: ReorderConfig<P>):
  ReorderableSlot<P & { id: string; excludeFromReorder?: boolean }>;
```

Effects:
- TypeScript forces every contributor to a wrapped slot to pass `id: string` — compile-time error, not a runtime warning.
- `excludeFromReorder?: boolean` is universally available without each slot owner remembering it.
- `Reorder.useArea(slot)` only accepts `ReorderableSlot<P>`. Calling it on an unwrapped slot is a TS error — the fix is to wrap the slot, which is the correct mental model (hosts can't unilaterally make a slot reorderable; only the slot owner can).

### 3. Edit mode is a module-level signal, not a React Context

`Core.Root` contributions render as siblings (not nested), so a Provider can't wrap the app from a plugin without forcing `shell-layout.tsx` to import from `@plugins/reorder/web`. To avoid that coupling, edit mode lives in a module-level store consumed via `useSyncExternalStore`. No provider, no bootstrap edits. The pen button calls `setEditMode(!editMode)`. A small `Core.Root` contribution mounts a global `keydown` listener for Esc.

### 4. Within-group drag only

When `getGroup` is configured, `onDragEnd` no-ops if dragged and target groups differ. Group order is fixed by natural plugin-registration discovery (first-seen order). Users reorder within a group; they cannot move items between groups, nor reorder groups themselves. PromptBar's `sectionOrder` numeric stays as-is.

### 5. Storage: per-worktree Postgres via Drizzle + `defineResource`

Each worktree owns its reorder prefs in its own DB. Worktrees fork main's DB on creation, so the user's main-namespace customizations propagate to fresh agent worktrees automatically; intra-worktree changes stay isolated. New table in `plugins/reorder/server/internal/tables.ts`:

```ts
export const _reorderPrefs = pgTable("reorder_prefs", {
  slotId:         text("slot_id").notNull(),
  contributionId: text("contribution_id").notNull(),
  rank:           rankText("rank").notNull(),
}, (t) => [primaryKey({ columns: [t.slotId, t.contributionId] })]);
```

Plugin `plugins/reorder/server/index.ts` (regular `ServerPluginDefinition`):

- `GET /api/reorder/:slotId` → `Record<contributionId, { rank: string }>`
- `PATCH /api/reorder/:slotId` body `{ contributionId, rank }`. Single upsert; on conflict update `rank`. Then `reorderPrefsResource.notify({ slotId })`.

`reorderPrefsResource` uses the existing per-worktree `defineResource` (push mode, parameterized by `slotId`) — same pattern as `authStateResource`/`tasksResource`. All open tabs of that worktree resort within ~50 ms.

No central plugin. No new gateway routes. No JSON file. Standard plugin shape.

### 6. DnD: `@dnd-kit/core`, copying `grouped` plugin's pattern

- `<DndContext>` per `Reorder.useArea` call (one per host slot/sublist) with `PointerSensor` (4px activation distance).
- Each item: `useDraggable({ id: _reorderKey })` + `useDroppable({ id: 'drop-' + _reorderKey })`.
- `onDragEnd` resolves before/after position from sorted siblings, computes new rank via `generateKeyBetween` from `@plugins/primitives/plugins/rank/shared`, PATCHes the server.

For a flat list, `generateKeyBetween` is sufficient — no need for `tree.computeDrop` (which wants tree-style `parentId`).

## Plugin Layout

```
plugins/reorder/
├── CLAUDE.md
├── package.json
├── shared/
│   ├── index.ts
│   └── resource.ts            # resourceDescriptor("reorder-prefs", schema)
├── server/
│   ├── index.ts               # ServerPluginDefinition: httpRoutes + reorderPrefsResource
│   ├── schema.ts              # re-exports tables for migrations
│   └── internal/
│       ├── tables.ts          # _reorderPrefs (slot_id, contribution_id, rank PK)
│       ├── repo.ts            # readSlotPrefs, upsertRank
│       ├── handlers.ts        # handleGetSlot, handlePatchSlot
│       └── resource.ts        # reorderPrefsResource (defineResource, push)
└── web/
    ├── index.ts               # PluginDefinition; exports `Reorder = { area, useArea }`; contributes pen button + Esc handler
    └── internal/
        ├── area.ts            # Reorder.area + internal slotId→config map
        ├── use-area.tsx       # Reorder.useArea hook
        ├── edit-mode-store.ts # module-level + useEditMode hook (useSyncExternalStore)
        ├── reorder-item.tsx   # <ReorderItem> wrapper component
        ├── dnd-wrapper.tsx    # <DndWrapper> component
        ├── pen-button.tsx     # toolbar pen button (excludeFromReorder)
        └── esc-handler.tsx    # Core.Root contribution, listens for Escape
```

`reorder` is `loadBearing: true` — it's primitive infra, not optional. Standard plugin: per-worktree server, no central component.

## Load-Bearing Code Sketches

### Edit-mode store (`web/internal/edit-mode-store.ts`)

```ts
import { useSyncExternalStore } from "react";

let editMode = false;
const listeners = new Set<() => void>();

export function setEditMode(v: boolean) {
  if (editMode === v) return;
  editMode = v;
  listeners.forEach((l) => l());
}
export function getEditMode() { return editMode; }

export function useEditMode(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => editMode,
    () => false,
  );
}
```

### `Reorder.area` wrapper (`web/internal/area.ts`)

```ts
import type { Slot } from "@core";

export type ReorderConfig<P> = {
  /** Group/section accessor; null/undefined disables grouping for the slot. */
  getGroup?: (item: P) => string | null;
};

export type ReorderableSlot<P> = Slot<P> & { readonly __reorder: true };

const registry = new Map<string, ReorderConfig<unknown>>();

export function area<P>(
  slot: Slot<P>,
  opts: ReorderConfig<P & { id: string }> = {},
): ReorderableSlot<P & { id: string; excludeFromReorder?: boolean }> {
  registry.set(slot.id, opts as ReorderConfig<unknown>);
  return slot as ReorderableSlot<P & { id: string; excludeFromReorder?: boolean }>;
}

export function lookupReorderConfig(slotId: string): ReorderConfig<unknown> | undefined {
  return registry.get(slotId);
}
```

### `Reorder.useArea` hook (`web/internal/use-area.tsx`)

```ts
type HostOverride<P> = {
  /** Per-host filter (e.g. Shell.Sidebar's three sublists). */
  filter?: (item: P) => boolean;
  /** Override the slot-level getGroup if the host needs different group semantics. */
  getGroup?: (item: P) => string | null;
};

type ReorderableItem<P> = P & {
  _reorderKey: string;
  _excluded: boolean;
};

export function useArea<P extends { id: string; excludeFromReorder?: boolean }>(
  slot: ReorderableSlot<P>,
  override?: HostOverride<P>,
) {
  const slotCfg = lookupReorderConfig(slot.id) as ReorderConfig<P> | undefined;
  const getGroup = override?.getGroup ?? slotCfg?.getGroup;
  const raw = slot.useContributions();
  const editMode = useEditMode();
  const { data: rankMap } = useResource(reorderPrefsDescriptor, { slotId: slot.id });

  const items = useMemo<ReorderableItem<P>[]>(() => {
    const filtered = override?.filter ? raw.filter(override.filter) : raw;
    const tagged = filtered.map((item, i) => ({
      ...item,
      _reorderKey: item.id,
      _excluded: !!item.excludeFromReorder,
      _rank: rankMap?.[item.id]?.rank ?? null,
      _natural: i,
    }));
    // Group-stable sort: discover groups in natural order; within each group,
    // sort by rank (ranked first), then by natural index.
    const groupOrder: string[] = [];
    const groupOf = (it: P) => getGroup ? getGroup(it) ?? "" : "";
    for (const t of tagged) {
      const g = groupOf(t);
      if (!groupOrder.includes(g)) groupOrder.push(g);
    }
    return tagged.sort((a, b) => {
      const ga = groupOrder.indexOf(groupOf(a));
      const gb = groupOrder.indexOf(groupOf(b));
      if (ga !== gb) return ga - gb;
      if (a._rank && b._rank) return a._rank.localeCompare(b._rank);
      if (a._rank) return -1;
      if (b._rank) return 1;
      return a._natural - b._natural;
    });
  }, [raw, rankMap, override?.filter, getGroup]);

  return { items, editMode, DndWrapper, ReorderItem };
}
```

`DndWrapper` is a memoized component that mounts `<DndContext>` with the current items + group accessor in scope; `onDragEnd` resolves drop position, computes `generateKeyBetween(prev?._rank, next?._rank)`, PATCHes the server, no-ops if cross-group. `ReorderItem` wraps its child in `useDraggable`/`useDroppable` and adds the wiggle animation when `editMode && !item._excluded`.

Because `id` is now required by the slot's prop type (added by `Reorder.area`), the hook can use `item.id` directly with no fallback or runtime warning — TypeScript guarantees it's there.

### Wiggle animation

Add a keyframe to `web/src/app.css`:

```css
@keyframes reorder-wiggle {
  0%   { transform: rotate(-1deg); }
  50%  { transform: rotate( 1deg); }
  100% { transform: rotate(-1deg); }
}
.reorder-wiggle { animation: reorder-wiggle 0.18s ease-in-out infinite; }
```

Random `animation-delay` per item via inline style (`Math.random() * 200ms`) so they don't shake in unison.

### Click suppression

`ReorderItem` renders `<div class="reorder-wiggle" style={{ touchAction: "none" }}>` plus, when in edit mode, an absolutely-positioned overlay `<div class="absolute inset-0 z-10" />` that captures pointer events so child buttons don't fire. The drag handlers attach to the wiggle wrapper, not the overlay.

### Server plugin (`server/index.ts`)

```ts
export default {
  id: "reorder",
  name: "Reorder",
  httpRoutes: {
    "GET /api/reorder/:slotId":   handleGetSlot,
    "PATCH /api/reorder/:slotId": handlePatchSlot,
  },
  resources: [reorderPrefsResource],
} satisfies ServerPluginDefinition;
```

`reorderPrefsResource` is a per-worktree `defineResource` parameterized by `{ slotId: string }`, push mode, schema `z.record(z.object({ rank: z.string() }))`. `handlePatchSlot` upserts the row in `_reorderPrefs` (Drizzle: `onConflictDoUpdate`), then calls `reorderPrefsResource.notify({ slotId })`. Drizzle migration is auto-generated by `./equin build`.

## Public API

The reorder plugin exports exactly two symbols on `@plugins/reorder/web`:

```ts
export const Reorder: {
  /** Slot owner: declare a slot reorderable. Returns the same slot, type-tagged. */
  area: <P>(slot: Slot<P>, opts?: ReorderConfig<P & { id: string }>) =>
    ReorderableSlot<P & { id: string; excludeFromReorder?: boolean }>;

  /** Host: render the slot's contributions with reorder behavior. */
  useArea: <P>(slot: ReorderableSlot<P>, override?: HostOverride<P>) =>
    { items: ReorderableItem<P>[]; editMode: boolean; DndWrapper: ComponentType; ReorderItem: ComponentType<{ item; children }> };
};
```

That's it. Slot owners reach into reorder; reorder reaches into nothing.

## End-to-End Example: Making `Conversation.AbovePromptInput` Reorderable

This walks the full plugin-author experience, start to finish — the same pattern applies to every other reorderable surface.

### Step 1 — Slot owner wraps the slot definition with `Reorder.area`

`plugins/conversations/plugins/conversation-view/web/slots.ts`:

```ts
import { defineSlot } from "@core";
import { Reorder } from "@plugins/reorder/web";

export const Conversation = {
  AbovePromptInput: Reorder.area(
    defineSlot<{ component: ComponentType<{ conversation: ConversationRecord }> }>(
      "conversation.above-prompt-input",
    ),
  ),
};
```

The slot owner does **not** add `id: string` — `Reorder.area` enriches the prop type with `id: string` and `excludeFromReorder?: boolean` automatically. This is the only line of "reorder awareness" in the consumer plugin; the reorder plugin never sees this file.

### Step 2 — Each contributor passes a stable `id` (TS-enforced)

`plugins/conversations/plugins/conversation-view/plugins/turn-summary/web/index.ts`:

```ts
contributions: [
  Conversation.AbovePromptInput({ id: "turn-summary", component: TurnSummaryCard }),
],
```

`plugins/conversations/plugins/conversation-view/plugins/quick-prompts/web/index.ts`:

```ts
contributions: [
  Conversation.AbovePromptInput({ id: "quick-prompts", component: QuickPromptChips }),
],
```

Forgetting `id` is a TypeScript error, not a runtime warning. Contributors don't import `Reorder` and don't need to know the slot is reorderable — they just satisfy the slot's prop type.

The `id` is the **stable storage key** for that contribution's rank; treat it like a DB primary key — never rename.

### Step 3 — The host renders with `Reorder.useArea`

Before (`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:86-89`):

```tsx
const abovePromptInputItems = Conversation.AbovePromptInput.useContributions();
// ...
{abovePromptInputItems.map((item, i) => {
  const Cmp = item.component;
  return <Cmp key={i} conversation={conversation} />;
})}
```

After:

```tsx
import { Reorder } from "@plugins/reorder/web";

const { items, DndWrapper, ReorderItem } = Reorder.useArea(Conversation.AbovePromptInput);
// ...
<DndWrapper>
  {items.map((item) => (
    <ReorderItem key={item._reorderKey} item={item}>
      <item.component conversation={conversation} />
    </ReorderItem>
  ))}
</DndWrapper>
```

Three new lines, one replaced map. `editMode`, drag handlers, wiggle, click suppression, persistence, live sync are all handled by `DndWrapper` + `ReorderItem` internally. Calling `Reorder.useArea` on a slot the owner didn't wrap is a TS error — guides you to the correct fix (wrap it).

### Step 4 — Build and verify

```bash
./equin build
```

The build:
- Picks up `_reorderPrefs` from `plugins/reorder/server/internal/tables.ts` and generates a migration.
- Registers `reorder` server plugin (routes `GET/PATCH /api/reorder/:slotId`).
- Restarts the server; migration applies on boot.
- Reloads the frontend; `Reorder.area(...)` runs as a synchronous side effect when each slot owner's `slots.ts` is first imported.

Open `http://<worktree>.localhost:9000`, click a conversation, scroll to the bottom. You should see `TurnSummaryCard` and `QuickPromptChips` in registration order. Click the pen on the top toolbar — they wiggle. Drag one above the other; on drop, the network panel shows `PATCH /api/reorder/conversation.above-prompt-input` body `{ contributionId: "quick-prompts", rank: "..." }`, and the resource notification rerenders both at the new positions. Reload — the order persists. Click the pen again — wiggle stops, the chips become clickable.

### Variant — A grouped slot (e.g. `Shell.Toolbar`)

The slot owner declares `getGroup` at wrap time:

```ts
// plugins/shell/web/slots.ts
import { defineSlot } from "@core";
import { Reorder } from "@plugins/reorder/web";

export const Shell = {
  Toolbar: Reorder.area(
    defineSlot<{ label?: string; icon?: ...; onClick?: () => void; component?: ComponentType; group?: string }>(
      "shell.toolbar",
    ),
    { getGroup: (i) => i.group ?? null },
  ),
};
```

The host code is identical to the flat case — `DndWrapper`/`ReorderItem` honor `getGroup` automatically. Drag-across-groups silently no-ops.

### Variant — A slot with multiple sub-lists in one host (`Shell.Sidebar`)

The slot owner declares the slot once with the slot-level `getGroup`. The host calls `Reorder.useArea` once per sub-list, each with a distinct `filter` override:

```ts
// plugins/shell/web/slots.ts (slot owner)
Sidebar: Reorder.area(
  defineSlot<{ title; icon; onClick?; component?; group?; labelExtra?; scroll? }>("shell.sidebar"),
  { getGroup: (i) => i.group ?? null },
),
```

```tsx
// shell-layout.tsx (host)
const buttons     = Reorder.useArea(Shell.Sidebar, { filter: (i) => !!i.onClick && !i.component });
const pinnedPanes = Reorder.useArea(Shell.Sidebar, { filter: (i) => !!i.component && !i.scroll, getGroup: () => null });
const scrollPanes = Reorder.useArea(Shell.Sidebar, { filter: (i) => !!i.component && i.scroll === true, getGroup: () => null });
```

Each call gets its own `DndWrapper`/`ReorderItem`; ranks live under the same `slotId="shell.sidebar"` but `id`s are globally unique within the slot, so contribution-id keys never collide between sublists. The `pinnedPanes`/`scrollPanes` calls override `getGroup` to `null` because pane sublists aren't grouped by the `group` field.

### Variant — A non-reorderable contribution in a reorderable slot

The pen button itself contributes to `Shell.Toolbar` but must not wiggle:

```ts
// plugins/reorder/web/index.ts
contributions: [
  Shell.Toolbar({
    id: "reorder-pen",
    excludeFromReorder: true,
    component: PenButton,
    group: "actions",
  }),
],
```

The `excludeFromReorder` field is part of the slot's prop type (added by `Reorder.area`), so this is fully typed. `ReorderItem` checks `item._excluded` and renders the child without wiggle/drag/overlay; the contribution is also skipped during rank lookup and PATCH.

## Migration Plan (single PR, ordered for incremental verification)

| # | Surface | File to change | Slot id | Group accessor | Notes |
|---|---|---|---|---|---|
| 1 | `Conversation.AbovePromptInput` | `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:86-89` | `conversation.above-prompt-input` | none | Smallest surface (2 contributors). Add `id` to `turn-summary`, `quick-prompts`. |
| 2 | `Conversation.ActionBar` | `plugins/conversations/plugins/conversation-view/plugins/action-bar/web/components/action-bar.tsx:4-19` | `conversation.action-bar` | none | ~10 contributors; add `id` to each. |
| 3 | `Shell.Toolbar` | `plugins/shell/web/components/shell-layout.tsx:251-260` | `shell.toolbar` | `i => i.group ?? null` | Pen button itself contributes here with `excludeFromReorder: true`. Group separator (`flex-1`) logic still applies — sort keeps groups contiguous. |
| 4 | `Conversation.PromptBar` | `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:16-47` | `conversation.prompt-bar` | `i => i.section` | Within-section reorder. `sectionOrder` still drives section ordering. |
| 5 | `Shell.Sidebar` | `plugins/shell/web/components/shell-layout.tsx:87-244` | `shell.sidebar` | `i => i.group ?? null` | Three `useReorderableSlot` calls, each with a different `filter` (buttons / pinnedPanes / scrollPanes). Buttons sublist uses `getGroup`; the others don't. |

Per-slot migration steps:
1. Wrap the slot definition with `Reorder.area(defineSlot<...>(slotId), opts?)` in the slot owner's `slots.ts`. (The wrapper adds `id: string` and `excludeFromReorder?` to the prop type — slot owner does not write these.)
2. Update each contributor with a stable explicit `id` (TS will fail the build until you do).
3. Replace the host's `useContributions()` + map with `Reorder.useArea()` + `<DndWrapper><ReorderItem>`.

Plugins to touch for `id` field migration (consolidated): `agents`, `auth`, `build`, `code-explorer`, `config`, `conversations-view` (3 sub-contribs), `debug`, `draw-on-app`, `improve`, `screenshot`, `stats`, `task-detail`, `theme` (2 contribs to Toolbar), `worktree-switcher`, plus all `Conversation.ActionBar` contributors (`terminal-pane`, `tasks-panel`, `commits-graph`, `code`, `open-app`, `vscode`, `push-counter`, `new-child-task`, `attempt-view`, `conversation-view` host), `Conversation.AbovePromptInput` (`turn-summary`, `quick-prompts`), `Conversation.PromptBar` (~7 contributors).

## Reusable Pieces (don't reinvent)

- `generateKeyBetween` from `@plugins/primitives/plugins/rank/shared` — fractional indexing.
- `@dnd-kit/core` (`useDraggable`, `useDroppable`, `DndContext`, `PointerSensor`) — established in `grouped` plugin.
- `useResource` + `defineResource` from `live-state` and `central/src/resources.ts` — live cross-worktree sync.
- Atomic file-write pattern (`.tmp` + `rename`) — copy from `secrets` storage.

## Verification

After each surface migration:

1. **Default render unchanged**: open `http://<worktree>.localhost:9000`, confirm visual order matches plugin-registration order. Network: `GET /api/reorder/<slotId>` returns `{}`.
2. **Enter edit mode**: click the pen on the top toolbar. Every reorderable item across all migrated surfaces wiggles. The pen does not wiggle (`excludeFromReorder`). Click on a non-pen toolbar/sidebar/bar item: nothing fires.
3. **Drag within group**: drag item A above item B (same group). Network: `PATCH /api/reorder/<slotId>` body `{ contributionId: "A", rank: "<key>" }`. Resource push arrives on `/ws/notifications` (or central WS) — UI reflects new order without reload.
4. **Cross-group drag is no-op**: drag a `Shell.Sidebar` button from "System" toward a pinned-pane area: PATCH never fires; UI snaps back.
5. **Persistence**: hard reload. New order persists. Edit mode is off (not persisted, intentional).
6. **Cross-tab same-worktree live sync**: open the same surface in two tabs of the same worktree; drag in tab A; tab B reorders within ~100 ms via the resource push. (Cross-worktree sync is intentionally absent — each worktree owns its prefs; the DB-fork on creation seeds new worktrees from main's state.)
7. **Esc exits edit mode**: in edit mode, press Escape. Wiggle stops, items become clickable again.

End-to-end: `./equin build`, then walk surfaces 1→5 and run the seven checks per surface.

## Risks and Open Questions

1. **Stable id discipline**: TypeScript enforces presence of `id: string` on every contributor to a wrapped slot — no runtime warning, no fallback. The remaining risk is a plugin author **renaming** an existing `id` (e.g. `"turn-summary"` → `"summary"`); the rank row keyed under the old id becomes orphaned and the contribution loses its persisted position. Mitigation: treat `id` as a stable storage key in CLAUDE.md; optionally add a `plugins/reorder/check/` that diffs `id` values against a tracked manifest at `./equin check` time. Defer to v1.5.
2. **Group order is locked to discovery order**: users can't move group "actions" to before "namespace" in the toolbar. v2 question.
3. **Section-order reorder for PromptBar**: v1 freezes `sectionOrder`. If users want to reorder Exit-vs-New section positions, that's v2.
4. **Click-suppression overlay and scroll**: in `Shell.Sidebar`'s scroll panes, the absolute-positioned overlay must allow `overflow-y` from the parent. Verify by entering edit mode with a scroll pane visible and confirming the wheel still scrolls the parent. If broken, switch to `pointer-events: none` on item children plus a single `pointer-events: auto` drag handle icon.
5. **Wiggle perf**: ~30 items wiggling at once should be fine (CSS transform animation, no re-render). Verify on a low-end machine when sidebar + toolbar + bars are all visible.
6. **Pen button reachability before any slot is reorderable**: not a real risk — registration is synchronous at import time, all five slots are registered immediately, and the pen button is itself a Toolbar contribution that just calls `setEditMode`.

## Critical Files

- `plugin-core/slots.ts` — read-only; no edits
- `plugins/reorder/**` — new
- `plugins/shell/web/slots.ts` — wrap `Sidebar` and `Toolbar` definitions with `Reorder.area`
- `plugins/shell/web/components/shell-layout.tsx` — replace toolbar render loop (line 251) and three sidebar render loops (lines 153, 197, 219, 239) with `Reorder.useArea` calls
- `plugins/conversations/plugins/conversation-view/web/slots.ts` — wrap `PromptBar` and `AbovePromptInput` with `Reorder.area`
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx` — replace `PromptBar` (line 16) and `abovePromptInputItems` map (line 86) with `Reorder.useArea`
- `plugins/conversations/plugins/conversation-view/plugins/action-bar/web/slots.ts` — wrap `ActionBar` with `Reorder.area`
- `plugins/conversations/plugins/conversation-view/plugins/action-bar/web/components/action-bar.tsx` — replace render loop with `Reorder.useArea`
- Each contributor plugin — one-line addition: `id: "<stable-name>"`
- `web/src/app.css` — add `@keyframes reorder-wiggle`
- `web/src/plugins.ts` — register `reorderPlugin` (load-bearing, near `live-state` / `pane`)
- `server/src/plugins.generated.ts` — auto-regenerated by build to include `reorder` server plugin
- `server/src/db/schema.ts` — auto-picks up the new `_reorderPrefs` table; migration auto-generated by `./equin build`
