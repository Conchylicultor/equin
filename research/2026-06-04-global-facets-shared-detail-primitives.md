# Facets v3 Phase 3-prep — Extract shared plugin-view detail primitives

## Context

Phase 3 of the facets rendering separation (`research/2026-06-02-global-facets-rendering-separation-v3.md`)
replicates the `render-diff` / `render-detail` / `render-catalog` trio across the remaining 8
facets. Before that fan-out, the small presentational helpers that every per-facet
`render-detail` section reuses must live in one shared home — otherwise each of the 8 new
sub-plugins copies them again.

Today these helpers are **already duplicated twice**:

- `SubHeading`, `PluginLink`, `ConsumerList` are defined inline in the old
  `plugins/plugin-meta/plugins/plugin-view/plugins/public-api/web/components/public-api-section.tsx`
  (lines 207-353).
- Phase 2's reference slice re-copied `PluginLink` + `ConsumerList` inline into
  `plugins/plugin-meta/plugins/facets/plugins/exports/plugins/render-detail/web/components/exports-detail-section.tsx`
  (lines 168-213).

The two copies have already drifted: the public-api copy uses the now-lint-flagged
`text-[10px]`, while the exports copy uses the compliant `text-3xs`. Extracting one shared
source fixes the drift and unblocks the fan-out.

**Goal:** one shared, lint-compliant definition of `SubHeading`, `PluginLink`, `ConsumerList`
in `plugin-view/web/components/`, exported from the `plugin-view` web barrel, with both current
consumers rewired to import them.

## Why `plugin-view` is the home (not a new primitives plugin)

`PluginLink` navigates by calling `useOpenPane(pluginViewPane, …)` — it is intrinsically
coupled to `pluginViewPane`, which `plugin-view` owns. `ConsumerList` is built on `PluginLink`.
`SubHeading` is a thin wrapper over the `collapsible` primitive used only by these detail
sections. None are generic enough to be a standalone primitive; co-locating them with the
already-exported `Section` (`plugin-view/web/components/section.tsx`) mirrors precedent and
keeps the dependency on `pluginViewPane` internal (relative `../panes` import, barrel-legal).

## Changes

### 1. New shared components (separate files, one per file — mirrors `section.tsx`)

`plugins/plugin-meta/plugins/plugin-view/web/components/plugin-link.tsx`
```tsx
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { pluginViewPane } from "../panes";

export function PluginLink({ name }: { name: string }) {
  const openPane = useOpenPane();
  return (
    <button
      className="font-medium text-muted-foreground hover:text-foreground hover:underline"
      onClick={(e) => {
        e.stopPropagation();
        openPane(pluginViewPane, { pluginId: name }, { mode: "swap" });
      }}
    >
      {name}
    </button>
  );
}
```

`plugins/plugin-meta/plugins/plugin-view/web/components/consumer-list.tsx` — the exports copy
verbatim (uses the lint-compliant `text-3xs`), importing `PluginLink` from `./plugin-link`.
Expandable list with `threshold = 2`, leading `←`, `+N` more button (stops propagation).

`plugins/plugin-meta/plugins/plugin-view/web/components/sub-heading.tsx` — the public-api copy
verbatim: `Collapsible` defaulting open, `CollapsibleChevron` + label + `(count)` trigger,
left-bordered content. Props `{ label: string; count: number; children: React.ReactNode }`.

### 2. Export from the web barrel

`plugins/plugin-meta/plugins/plugin-view/web/index.ts` — add alongside the existing
`Section` export:
```ts
export { PluginLink } from "./components/plugin-link";
export { ConsumerList } from "./components/consumer-list";
export { SubHeading } from "./components/sub-heading";
```
(Barrel purity preserved — re-exports of the plugin's own internal files only.)

### 3. Rewire consumer A — `exports/render-detail` (the keeper)

`…/facets/plugins/exports/plugins/render-detail/web/components/exports-detail-section.tsx`:
- Delete the local `ConsumerList` (168-196) and `PluginLink` (200-213) and the now-unused
  `useState`, `useOpenPane`, `pluginViewPane` imports.
- Import `ConsumerList` from `@plugins/plugin-meta/plugins/plugin-view/web` (already a dep).

### 4. Rewire consumer B — `public-api-section` (slated for Phase 4.3 deletion, rewired now to kill the duplicate in the interim)

`…/plugin-view/plugins/public-api/web/components/public-api-section.tsx`:
- Delete the local `SubHeading` (317-338), `PluginLink` (340-353), and `ConsumerList`
  (207-235).
- Import all three from `@plugins/plugin-meta/plugins/plugin-view/web` (already a dep).
- Remove `useOpenPane` import; keep `useState`/`useMemo` (still used by `ImportedByBanner`/
  `RuntimeGroup`). `ImportedByBanner` stays local (it will move to a `cross-refs/render-detail`
  in Phase 3 proper) and now consumes the shared `PluginLink`.
- Note the shared `ConsumerList` uses `text-3xs`; public-api's old copy used `text-[10px]` —
  this is the intended convergence on the lint-compliant token (visually ~identical).

## Critical files

| File | Change |
|---|---|
| `…/plugin-view/web/components/plugin-link.tsx` | NEW |
| `…/plugin-view/web/components/consumer-list.tsx` | NEW |
| `…/plugin-view/web/components/sub-heading.tsx` | NEW |
| `…/plugin-view/web/index.ts` | export the 3 |
| `…/facets/plugins/exports/plugins/render-detail/web/components/exports-detail-section.tsx` | drop local copies, import shared |
| `…/plugin-view/plugins/public-api/web/components/public-api-section.tsx` | drop local copies, import shared |

## Out of scope

- The remaining 8 facets' `render-*` sub-plugins (Phase 3 proper).
- `ImportedByBanner` extraction (moves to `cross-refs/render-detail` in Phase 3).
- Deleting the `public-api` plugin (Phase 4.3).

## Verification

1. `./equin build` succeeds (frontend + server + boundary/lint checks pass — the
   `plugin-boundaries` check confirms the new barrel exports are legal and no deep imports).
2. `./equin check --plugin-boundaries` and `eslint` pass (no `text-[10px]`, barrel purity).
3. Screenshot the plugin detail pane for a plugin with exports + consumers (e.g. open Forge,
   select a plugin) via `e2e/screenshot.mjs` — confirm the Exports section still renders runtime
   groups, category badges, and `← consumer` links identically.
4. `rg "function ConsumerList|function PluginLink|function SubHeading" plugins/` returns only
   the three new shared files (no duplicate definitions remain).
