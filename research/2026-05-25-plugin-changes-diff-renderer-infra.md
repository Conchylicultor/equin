# Phase 1: DiffRenderer Infrastructure in plugin-changes

## Context

The `plugin-changes` plugin computes API diffs between a worktree and its base. The server
(`compute-plugin-diff.ts`) hardcodes 7 helper functions that project `PluginNode` compat fields
into string arrays, then runs `diffSets` to produce pre-computed `DiffList` objects sent to the
client. The client (`api-changes-section.tsx`) hardcodes 7 `<DiffSection>` calls matching these
fields.

Both sides are broken: `buildPluginTree` is called with `skipBarrelImport: true`, which skips
the entire facet pipeline, so all compat fields are empty — the 7 helpers always return `[]`.

The fix (across multiple phases) is to:
1. Have each facet sub-plugin contribute a `DiffRenderer` via a web slot
2. Have the server send raw facet data instead of pre-computed diffs
3. Have the client compute diffs using contributed renderers

**Phase 1 (this task)** is infrastructure only: define the `DiffRenderer` interface and web
slot. No facets change, no protocol change, no wiring.

## Protocol Evolution Design (future phases, informs Phase 1 choices)

### Current flow
```
Server: buildPluginTree → 7 hardcoded helpers → diffSets → PluginChangeDiff { slots: DiffList, ... }
Client: api-changes reads plugin.slots, plugin.exports, ... and renders 7 <DiffSection>s
```

### Target flow (Phase 4)
```
Server: buildPluginTree → sends raw facets → PluginChangeDiff { currentFacets, baseFacets }
Client: iterates DiffRenderer contributions → toComparable + diffSets → renders dynamically
```

### Phase-by-phase protocol evolution

**Phase 2 (reference impl):** First facet (exports) contributes a `DiffRenderer`. Server
unchanged — the contribution exists but isn't consumed yet.

**Phase 3 (replicate):** All 7 facets contribute DiffRenderers.

**Phase 4 (migrate consumers):**
- `buildPluginTree` runs the facet pipeline even with `skipBarrelImport: true` (7/9 facets
  are static-only and work without barrel imports)
- Server adds `currentFacets: Record<string, unknown>` and `baseFacets: Record<string, unknown>`
  to `PluginChangeDiff`, alongside existing 7 `DiffList` fields (backward compat)
- `diffSets` moves from `server/internal/compute-plugin-diff.ts` to `core/` so the web side
  can import it
- `api-changes` iterates `DiffRenderer.useContributions()` and computes diffs client-side:
  ```ts
  for (const renderer of renderers) {
    const current = renderer.toComparable(plugin.currentFacets[renderer.facetId] ?? undefined);
    const base = renderer.toComparable(plugin.baseFacets[renderer.facetId] ?? undefined);
    diffs.push({ label: renderer.label, diff: diffSets(current, base) });
  }
  ```
- Hardcoded 7 `DiffList` fields and 7 server helpers removed

### Why `facetId` is a plain string (not `FacetDef<T>`)

`DiffRenderer` lives in `plugin-changes/core`, which must not import from `@plugins/plugin-meta`.
The type relationship is enforced by convention: each contributor casts `unknown` to its known
type inside `toComparable`. This keeps plugin-changes decoupled from the facet system.

## Phase 1 Implementation

### Step 1: Add `DiffRenderer` interface

**File:** `plugins/review/plugins/plugin-changes/core/diff-renderer.ts` (NEW)

```ts
export interface DiffRenderer {
  facetId: string;
  label: string;
  toComparable: (facetData: unknown) => string[];
}
```

Design choices:
- Separate file from `protocol.ts` — `protocol.ts` is the HTTP contract (what the server
  sends), `diff-renderer.ts` is the slot contribution contract (what plugins contribute).
  These are different concerns that evolve independently.
- `facetData: unknown` not `any` — each contributor casts to its known type internally.
- No `id` field — `defineSlot` (unlike `defineRenderSlot`) doesn't require `id` on the
  contributed type. `facetId` serves as the natural identifier.

### Step 2: Export from `core/index.ts`

**File:** `plugins/review/plugins/plugin-changes/core/index.ts`

Add `DiffRenderer` to exports:
```ts
export type { DiffRenderer } from "./diff-renderer";
```

### Step 3: Add `PluginChanges.DiffRenderer` slot

**File:** `plugins/review/plugins/plugin-changes/web/slots.ts`

Add to the existing `PluginChanges` object:
```ts
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { DiffRenderer, ... } from "../core";

export const PluginChanges = {
  Section: defineRenderSlot<...>(...),  // existing

  DiffRenderer: defineSlot<DiffRenderer>(
    "review.plugin-changes.diff-renderer",
    { docLabel: (p) => p.label },
  ),
};
```

Design choices:
- `defineSlot` not `defineRenderSlot` — DiffRenderer is a logic contribution (functions),
  not a visual component. Follows the pattern of `Shortcuts.Shortcut`, `Markdown.Extension`.
- Slot ID `"review.plugin-changes.diff-renderer"` mirrors the existing
  `"review.plugin-changes.section"` convention.
- `docLabel: (p) => p.label` — produces readable labels ("Slots", "Exports") in
  `plugins-details.md`.

### Step 4: No change to `web/index.ts`

The barrel already exports `PluginChanges as PluginChangesSlots`. Since `DiffRenderer` is
added to the `PluginChanges` object, `PluginChangesSlots.DiffRenderer` is automatically
available. No barrel edit needed.

## Files Changed

| File | Action |
|------|--------|
| `plugins/review/plugins/plugin-changes/core/diff-renderer.ts` | NEW |
| `plugins/review/plugins/plugin-changes/core/index.ts` | Add export |
| `plugins/review/plugins/plugin-changes/web/slots.ts` | Add DiffRenderer slot |

## What Phase 1 does NOT do

- Does not move `diffSets` to `core/` (deferred to Phase 4 when the client actually needs it)
- Does not change `PluginChangeDiff` protocol (no `currentFacets`/`baseFacets`)
- Does not touch `compute-plugin-diff.ts` or `api-changes-section.tsx`
- Does not create any facet render-diff sub-plugins

## Verification

1. `./equin build` succeeds
2. `./equin check` passes
3. The slot is dormant: `PluginChangesSlots.DiffRenderer.useContributions()` returns `[]`
4. Existing plugin-changes UI is unchanged (no behavioral difference)
5. Future contributors can use the slot:
   ```ts
   import { PluginChangesSlots } from "@plugins/review/plugins/plugin-changes/web";
   import type { SlotDef } from "@plugins/plugin-meta/plugins/facets/plugins/slots/core";
   contributions: [
     PluginChangesSlots.DiffRenderer({
       facetId: "slots",
       label: "Slots",
       toComparable: (data) => (data as SlotDef[] ?? []).map(s => `${s.groupName}.${s.memberName}`),
     }),
   ]
   ```
