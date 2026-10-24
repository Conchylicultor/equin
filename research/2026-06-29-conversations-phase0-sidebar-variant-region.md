# Phase 0 — Scaffold the conversations-sidebar variant switch + expose the data layer

> Sub-plan for **Phase 0** of the global migration map
> ([`research/2026-06-29-global-conversations-dataview-migration.md`](./2026-06-29-global-conversations-dataview-migration.md)).
> Net user-visible behavior must be unchanged: the switch exists with the current
> view as its only variant.

## Context

The Conversations sidebar list (the **Queue / Grouped / History** tabbed section)
is bespoke UI mounted directly as `ConversationsView.Host` (a `defineTabbedView`).
The long-term goal is to rebuild this list on the official **DataView** primitive
without ever losing the working view as a fallback. Phase 0 lays the rails:

1. **A switch.** Make the sidebar body a `variant-region` with two variants —
   `classic` (today's `Host`) and (later) `dataview` — selectable from a picker
   **in the sidebar, directly below the launch button**, persisted via config.
   The mount point stays blind to the variant set (collection–consumer
   separation), so the endgame (Phase 4) is a **pure deletion** of `classic/`.
2. **Expose the data layer.** Make the queue/grouped resources + mutation
   endpoints + the client rank helper consumable from a *separate* plugin via
   public barrels — so the future `dataview` variant reads the *same* resources
   and calls the *same* mutations as `classic`, which is what makes the fallback
   trustworthy by construction.

Audit result: the resources (`queueRanksResource`, `conversationGroupsResource`)
and **all ten** mutation endpoints (queue `reorder/promote/demote/step-down/rerank`,
group CRUD) are **already public** on `…/queue/shared` and `…/grouped/shared`.
The **only** genuinely-private client data helper is `applyReorder` (the pure
client-side reorder prediction). Everything else in the queue/grouped web layers
(`QueueRow`, `SectionHeader`, `GroupBox`, drag-id parsing, `useTaskAutoGroups`,
pin rendering) is **presentation** — per "duplicate presentation, not data" it
stays private and will be rebuilt, not shared.

## End state of Phase 0

- A `sidebar-region` variant-region wraps the sidebar conversation body.
- `classic/` is its own plugin registering today's `Host` as variant `"classic"`
  (the only variant; default). Deleting it later requires zero mount-point edits.
- Launch button + variant picker render as shared chrome in the mount point;
  the picker shows a single `Classic` option (proves the wiring is live).
- `applyReorder` (+ `ReorderVars`) is exported from the queue web barrel.
- `./equin build` succeeds; the conversation list is pixel-identical.

## Plugin layout (new)

```
conversations-view/plugins/
  sidebar-region/          NEW  — defines the variant region (the switch)
    core/index.ts            defineVariantRegion + the variant Props type
    web/index.ts             Region + Picker + region contributions
    web/region.ts            defineVariantRegionWeb wiring, exports SidebarRegion.Variant
    server/index.ts          variantRegionServerContribution (mandatory)
  classic/                 NEW  — registers today's Host as variant "classic"
    web/index.ts             SidebarRegion.Variant({ id:"classic", … })
    web/components/classic-body.tsx
```

`data-view/` is **not** created in Phase 0 (no second variant yet — that is
Phase 1: History as a DataView).

### Why two plugins, not one

`classic/` must be a **separate** plugin from `sidebar-region/` so Phase 4 is a
pure deletion. If `sidebar-region` registered the classic variant itself,
removing classic would mean editing `sidebar-region`.

### Dependency direction (no cycles)

- mount point (`conversations-view`) → `sidebar-region/web` (renders `Region`).
- `classic` → `sidebar-region/{web,core}` (Variant slot + Props type) **and**
  `conversations-view/web` (`ConversationsView.Host`). `classic` is a leaf.
- **`sidebar-region` imports neither** `conversations-view` nor `classic`.

This is the load-bearing constraint: the mount point imports `sidebar-region`,
so `sidebar-region` must not import back into `conversations-view` (a type-only
import counts as an edge and would form a cycle). Therefore the variant **Props
type lives in `sidebar-region/core`**, not in `conversations-view/web/slots.ts`.

## Implementation

### 1. `sidebar-region/core/index.ts` — define the region

The variant Props are exactly what each variant component receives — structurally
identical to today's `ViewProps`. Define them here (own them in core):

```ts
import { defineVariantRegion } from "@plugins/ui/plugins/variant-region/core";

export interface ConversationSidebarProps {
  activeId: string | null;
  onNavigate: (id: string) => void;
  onCloseConversation: (id: string, e: React.MouseEvent) => Promise<void>;
}

export const conversationsSidebarRegion =
  defineVariantRegion<ConversationSidebarProps>({
    id: "conversations-sidebar",   // config key + slot id
    label: "Conversation list",
    defaultVariant: "classic",     // MUST match a contributed variant id
    // no `scope` → single global value (this sidebar only exists in agent-manager)
  });
```

> `conversations-view`'s existing `ViewProps` (consumed by the queue/grouped/
> history tabs) stays as-is; it is structurally identical, so `classic` can spread
> these props straight into `Host`. The two converge at Phase 4 when the tabbed
> view is deleted. (We deliberately do **not** re-export one as the other — that
> would be a forbidden cross-plugin re-export.)

### 2. `sidebar-region/web/region.ts` + `web/index.ts`

Mirror `sidebar-framing` / `app-rail-framing` byte-for-byte:

```ts
// region.ts
import { defineVariantRegionWeb } from "@plugins/ui/plugins/variant-region/web";
import { conversationsSidebarRegion } from "../core";

export const conversationsSidebarRegionWeb =
  defineVariantRegionWeb(conversationsSidebarRegion);

export const SidebarRegion = { Variant: conversationsSidebarRegionWeb.Variant };
```

```ts
// index.ts — spread the 3 region contributions; export Region + Picker + SidebarRegion
export { SidebarRegion } from "./region";
export { conversationsSidebarRegionWeb } from "./region";

export default {
  contributions: [...conversationsSidebarRegionWeb.contributions],
} satisfies PluginDefinition;
```

> The mount point imports `Region` and `Picker` from
> `conversationsSidebarRegionWeb`; this plugin doesn't mount them itself (it has no
> slot of its own to mount into — the parent owns the sidebar section).
> `…contributions` registers the config web-register, the dynamic-enum options, and
> the theme-customizer picker group; spreading it is mandatory.

### 3. `sidebar-region/server/index.ts`

```ts
import { variantRegionServerContribution } from "@plugins/ui/plugins/variant-region/server";
import { conversationsSidebarRegion } from "../core";

export default {
  contributions: [variantRegionServerContribution(conversationsSidebarRegion)],
} satisfies ServerPluginDefinition;
```

> Omitting this is a loud boot failure (config descriptor unregistered server-side).

### 4. `classic/web/components/classic-body.tsx` + `web/index.ts`

The classic body renders the Host **headerless** (launch moves to the mount point):

```tsx
// classic-body.tsx
import { ConversationsView } from "@plugins/conversations/plugins/conversations-view/web";
import type { ConversationSidebarProps } from "@plugins/conversations/plugins/conversations-view/plugins/sidebar-region/core";

export function ClassicBody(props: ConversationSidebarProps) {
  return <ConversationsView.Host {...props} />;   // no `header` → just tabs + list
}
```

```ts
// index.ts
import { SidebarRegion } from "@plugins/conversations/plugins/conversations-view/plugins/sidebar-region/web";
import { ClassicBody } from "./components/classic-body";

export default {
  contributions: [
    SidebarRegion.Variant({
      id: "classic", label: "Classic", match: "classic", component: ClassicBody,
    }),
  ],
} satisfies PluginDefinition;
```

> Invariants: `id === match`, and `id` must equal the region's `defaultVariant`
> (`"classic"`), else the host silently falls back to `contributions[0]`.

### 5. Mount point — `conversations-view/web/components/conversation-list.tsx`

Replace the single `<ConversationsView.Host header={…} …/>` with shared chrome
(launch, then picker) above the region. Per the chosen **Below launch** layout:

```tsx
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import {
  conversationsSidebarRegionWeb,
} from "@plugins/conversations/plugins/conversations-view/plugins/sidebar-region/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

const { Region, Picker } = conversationsSidebarRegionWeb;

export function ConversationList() {
  // …unchanged: activeId, navigate, handleCloseConversation…
  return (
    <Stack /* column */ className="...">
      <Stack gap="xs" className="px-sm pb-xs">
        <LaunchControl variant="outline" fullWidth />
        <Picker />
      </Stack>
      <Region
        activeId={activeId}
        onNavigate={navigate}
        onCloseConversation={handleCloseConversation}
      />
    </Stack>
  );
}
```

> The exact wrapper must reproduce the spacing that `Host` previously applied to
> its `header` block (`<Stack gap="xs" className="px-sm pb-xs">`) so the launch
> button keeps its current padding. Verify against a before/after screenshot.
> `Picker` is the variant-region's built-in row of pill buttons (`Stack
> direction="row" gap="sm"`) — fine for the sidebar; renders one `Classic` button
> in Phase 0.

### 6. Expose the client data helper — `queue/web/index.ts`

The web barrel today only default-exports. Add the rank helper (barrel purity
allows re-exports of the plugin's own internal files alongside the single default):

```ts
export { applyReorder } from "./components/apply-reorder";
export type { ReorderVars } from "./components/apply-reorder";
```

> This is the **only** data-layer promotion Phase 0 needs. Do **not** promote
> server tables (`_queueState`) or grouped repo fns (`createGroupWithMembers`,
> …) — a *client* consumer reads resources and calls endpoints; it never touches
> those, and exposing them would violate "expose only what's consumed."

### 7. Build / registry / docs

Run `./equin build` — it regenerates the plugin registry roots
(`web.generated.ts` / `server.generated.ts`) from the filesystem and the
`plugins-*-doc-in-sync` docs. Do not hand-edit those.

## Critical files

| Action | Path |
|---|---|
| Rewrite mount point | `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` |
| New region core | `…/conversations-view/plugins/sidebar-region/core/index.ts` |
| New region web | `…/conversations-view/plugins/sidebar-region/web/{region.ts,index.ts}` |
| New region server | `…/conversations-view/plugins/sidebar-region/server/index.ts` |
| New classic variant | `…/conversations-view/plugins/classic/web/{index.ts,components/classic-body.tsx}` |
| Promote rank helper | `…/conversations-view/plugins/queue/web/index.ts` |
| Reference: variant-region | `plugins/ui/plugins/variant-region/{core,web,server}` |
| Reference: existing consumers | `plugins/ui/plugins/sidebar-framing/`, `plugins/apps-core/plugins/app-rail-framing/` |
| Unchanged contract | `…/conversations-view/web/slots.ts` (`ViewProps`, `ConversationsView`) |

## Verification

1. `./equin build` (from the worktree) — must succeed; regenerates registry
   + docs.
2. `./equin check plugin-boundaries` and `./equin check` — confirm no
   cycle (`sidebar-region` ↮ `conversations-view`), barrels in sync, no boundary
   violations.
3. Open `http://<worktree>.localhost:9000` → agent-manager sidebar:
   - The **Conversations** list is pixel-identical (Queue/Grouped/History tabs,
     drag-reorder, pin, group create/join all still work — same DB rows).
   - A **launch button** then a **single-option picker** (`Classic`) appear above
     the tab switcher.
   - Use `e2e/screenshot.mjs` to capture before/after of the sidebar and diff
     the list region.
4. Sanity that the data helper is reachable: confirm `applyReorder` resolves from
   `@plugins/conversations/plugins/conversations-view/plugins/queue/web` (a type
   import from a scratch check, or simply that the queue's own
   `useOptimisticResource({ apply: applyReorder })` still type-checks after the
   re-export).
5. `bun test plugins/conversations/plugins/conversations-view/plugins/queue/web/components/apply-reorder.test.ts`
   — the existing reorder-prediction test still passes (helper unmoved, only
   re-exported).

## Out of scope (later phases)

- The `dataview` variant and any DataView wiring (Phase 1+).
- New DataView primitive capabilities — group-by sections, flat manual-order,
  aggregating sections (Phase 2).
- Deleting `classic/` / collapsing the region (Phase 4).
