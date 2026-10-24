# Per-slot contributor reverse index

## Context

When a plugin defines a contribution slot, there is no way to discover **every plugin that contributes to that specific slot id** at the place an agent looks before touching the slot. Migrating a slot's contract looks complete after updating the owning plugin and its in-tree contributors — but contributors living in *other* plugins are invisible until a full repo-wide `./equin build` surfaces them as type errors.

Concrete instance: migrating the `data-view` per-item action slot (`defineItemActions`), the contributors in `apps/story/pages-integration` and `tasks/auto-start` were missed until the build failed; they were only findable via a manual repo-wide `rg`.

A reverse index *already exists* but at the wrong granularity: the **contributions** facet's `relate()` builds `slotContributors: string[]` — a **plugin-level aggregate** of every plugin that contributes to *any* slot the owner defines, flattened, keyed only on the slot **group head** (`c.slot.split(".")[0]`), rendered by short name. It cannot answer "who contributes to *this one slot*."

**Goal:** a true **per-slot** reverse index — each `SlotDef` carries the full plugin ids of its contributors — surfaced in the per-plugin autogen CLAUDE.md block, `plugins-details.md`, and the Studio slot surfaces (detail section + contributions table). The `slots` facet's own TODO already anticipates this:

> `slots/CLAUDE.md`: "No `relate()` yet — slot contributors will be wired once the `contributions` facet exists."

The architecture rule confirms the home: *"a facet's `relate()` writes its cross-plugin reverse indexes into its own facet data"* (`facets/CLAUDE.md`). The per-slot reverse index belongs on the **slots** facet (it owns slots), replacing the plugin-level aggregate on the contributions facet.

### Decisions (confirmed)
- Contributor identity: **full plugin id / path** (`apps/story/pages-integration`), not short name — disambiguates collisions (many `shell`s) and is directly actionable.
- **Defer** cross-refs facet integration; still update the **plugin-view** slot rendering (detail section + Studio contributions table).
- Compact docs (`plugins-compact.md`) intentionally carry **no** facet data (name + description only) — leave them lean; not a surface for this.

## Design

Add a `relate()` to the **slots** facet that, for every `SlotDef`, fills a new `contributors: string[]` (full plugin ids) by reading the **contributions** facet's *extract* data across the tree. No new `dependsOn` is needed and no cycle is introduced: all `extract()` runs before any `relate()`, and the slots `relate()` reads only contributions **extract** output (`data.static`, `data.runtime`) plus the iterating node's own `id` — never contributions' `relate()` output. (`contributions` keeps its existing `dependsOn: [slots]`; the two `relate()`s have no inter-dependency.)

**Matching (per slot, not per group):**
- **Runtime contributions** (present in the docgen/`build` path, which barrel-imports): exact match on `c.slotId === SlotDef.slotId`. This is the authoritative, precise source for the CLAUDE.md/`details.md` surfaces.
- **Static contributions** (the only source in the Studio `/api/plugin-view/tree` path, which runs `skipBarrelImport`): match on group head + last segment — `parts = c.slot.split(".")`, key `` `${parts[0]}.${parts.at(-1)}` `` against `` `${groupName}.${memberName}` ``. Robust for both flat (`PluginView.Section`) and nested (`Sonata.Toolbar.Start` → `Sonata.Start`) symbols, and for single-member slots (`group === member`).

The contributor is always the **iterating node's `id`** (no dependence on `c.pluginId`, which is filled by contributions' own `relate()`). Dedupe + sort each slot's `contributors`.

The existing **plugin-level aggregate** (`slotContributors` on the contributions facet) is **removed** — superseded by the per-slot list rendered on the slot owner. The forward link `c.definerPluginId` (used by `ContributionsDetailSection`'s `PluginLink`) stays.

## Changes

### 1. `SlotDef` gains `contributors`
`plugins/plugin-meta/plugins/facets/plugins/slots/core/types.ts`
- Add `contributors: string[]` (full plugin ids; populated by `relate()`).

`plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`
- Initialize `contributors: []` at every `SlotDef` creation site (`parseSlotCalls` push, the two `parseDefineGroup` callbacks, the two `collectRuntimeSlots` pushes).
- Add `relate(rawCtx)`:
  - Import `getFacet`, `type PluginTree`/`PluginNode`, and `contributionsFacetDef` from `@plugins/plugin-meta/plugins/facets/plugins/contributions/core` (facet→core edge; no cycle).
  - Reset `slot.contributors = []` for all slots; build `slotById: Map<slotId, SlotDef[]>` and `slotByGroupMember: Map<"group.member", SlotDef[]>`.
  - For each node with contributions data: push `node.id` onto matching slots — runtime by `slotId`, static by the head+last-segment key.
  - Dedupe (`Set`) + sort each `slot.contributors`.
- Update `renderDoc`: per slot, `` `Group.Member` `` and, when contributors exist, ` ← ` + comma-joined `` `id` `` list. (Keeps everything under the existing `web / Slots` fact.)
- Verify `slotsToComparable` (`slots/core`) does **not** project `contributors` (avoid PR-diff noise from a derived reverse index) — it projects explicit fields, so confirm the new field is excluded.

### 2. Remove the plugin-level aggregate from contributions
`plugins/plugin-meta/plugins/facets/plugins/contributions/core/types.ts`
- Remove `slotContributors: string[]` from `ContributionsFacetData`.

`plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`
- `extract`: drop `slotContributors: []` from the returned object.
- `relate`: keep `slotGroupToOwner` + `c.definerPluginId` assignment; **remove** the `ownerData.slotContributors.push(...)` lines and the trailing sort loop.
- `renderDoc`: remove the `cross-plugin / Slot contributors` fact.

### 3. Studio plugin-view detail section (slots)
`plugins/plugin-meta/plugins/facets/plugins/slots/plugins/render-detail/web/components/slots-detail-section.tsx`
- Below each slot row, when `s.contributors.length > 0`, render a wrapped list of `PluginLink` (import from `@plugins/plugin-meta/plugins/plugin-view/web`, as `ContributionsDetailSection` does) — `name={id} label={id}` — so contributors are navigable. Reads `node.facets["slots"]` (already typed `SlotDef[]`; new field flows through automatically).

### 4. Studio contributions facet table (slots)
`plugins/plugin-meta/plugins/facets/plugins/slots/plugins/render-contributions/web/slots-facet-table.tsx`
- Add `contributors: string[]` to `SlotRow` (from `s.contributors`).
- Add a "Contributors" column rendering the ids as wrapped `PluginChip`s (already imported), with a `value` for sort/search.

### 5. Remove aggregate from contributions detail section
`plugins/plugin-meta/plugins/facets/plugins/contributions/plugins/render-detail/web/components/contributions-detail-section.tsx`
- Drop the `slotContributors` destructure, its render block, and the `ConsumerList` import if now unused; simplify the early return to `if (contribs.length === 0) return null;`.

### 6. Hand-written CLAUDE.md prose (autogen blocks regenerate via build)
- `slots/CLAUDE.md`: replace the "No `relate()` yet …" sentence with a description of the per-slot contributor `relate()`.
- `slots/plugins/render-detail/CLAUDE.md` & `render-contributions/CLAUDE.md`: mention contributors in the prose.
- `contributions/plugins/render-detail/CLAUDE.md`: remove "plus a 'Slot contributors' list".

## Critical files
- `plugins/plugin-meta/plugins/facets/plugins/slots/core/types.ts`
- `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`
- `plugins/plugin-meta/plugins/facets/plugins/slots/plugins/render-detail/web/components/slots-detail-section.tsx`
- `plugins/plugin-meta/plugins/facets/plugins/slots/plugins/render-contributions/web/slots-facet-table.tsx`
- `plugins/plugin-meta/plugins/facets/plugins/contributions/core/types.ts`
- `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`
- `plugins/plugin-meta/plugins/facets/plugins/contributions/plugins/render-detail/web/components/contributions-detail-section.tsx`

## Verification

1. `./equin build` — must succeed and regenerate per-plugin CLAUDE.md autogen blocks + `docs/plugins-details.md`. The `plugins-doc-in-sync`, `facets:render-complete`, `type-check`, and `plugin-boundaries` checks must pass (run `./equin check`).
2. Confirm the per-slot list landed: inspect `primitives/data-view`'s CLAUDE.md "Slots" fact (and `plugins-details.md`) — the item-action slot must now list `apps/story/pages-integration` and `tasks/auto-start`, the previously-invisible cross-plugin contributors. (`rg "pages-integration" docs/plugins-details.md`.)
3. Studio UI — screenshot against `http://att-1781530663-rp5y.localhost:9000`:
   - Plugin-view detail for a slot-owning plugin (e.g. data-view) → Slots section shows contributor links per slot.
   - Studio → Contributions → Slots tab → new Contributors column populated.
   Use `bun e2e/screenshot.mjs --url <studio plugin-view url> --out /tmp/slots`.
4. Sanity: a slot with no external contributors renders with no ` ← ` suffix; contributor ids are full paths, deduped and sorted.
