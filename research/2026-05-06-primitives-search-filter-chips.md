# Search & Filter Chips Primitives

## Context

11 files across the codebase implement user-facing filter UI, all reinventing the same patterns independently:

- **FilterChip** toggle buttons: copy-pasted in `debug/queue`, `debug/claude-cli-calls`, and `forge/catalog` (3 independent implementations)
- **Text search** with `toLowerCase().includes()`: reimplemented in `forge/publish` (tree filter), `forge/catalog` (flat filter passed as prop to 5 table components), `blocked-by` and `blocking` (identical conversation search)

No shared search/filter primitive exists in `plugins/primitives/`.

This plan extracts two new primitives under `plugins/primitives/plugins/`: **filter-chips** (enum-toggle chips) and **search** (text search input + tree filter utilities). Then refactors all consumers to use them.

## New Plugins

### 1. `plugins/primitives/plugins/filter-chips/`

```
plugins/primitives/plugins/filter-chips/
  package.json        # @singularity/plugin-primitives-filter-chips
  web/
    index.ts          # barrel: exports + PluginDefinition
    internal/
      filter-chips.tsx
```

**Exports:**

```ts
// Component — the toggle button
function FilterChip({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element
// Uses: cn("flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors", ...)

// Component — labeled section wrapper
function FilterGroup({ label, children }: {
  label: string;
  children: React.ReactNode;
}): JSX.Element

// Hook — manages single-dimension chip filter state
function useChipFilter<T extends string>(allValue: T): {
  value: T;
  setValue: (v: T) => void;
  matches: (itemValue: T) => boolean;  // true when value === allValue || value === itemValue
}
```

`useChipFilter` keeps state internal (both consumers are self-contained). For multi-dimension filtering (calls-view), call the hook twice — once per dimension. The `matches` predicate is memoized via `useCallback`.

### 2. `plugins/primitives/plugins/search/`

```
plugins/primitives/plugins/search/
  package.json        # @singularity/plugin-primitives-search
  web/
    index.ts          # barrel: exports + PluginDefinition
    internal/
      search-input.tsx
      use-text-filter.ts
      filter-tree.ts
```

**Exports:**

```ts
// Component — wraps shadcn Input with MdSearch icon
// Matches the existing pattern in reorder/use-area.tsx:454-460
function SearchInput(props: React.InputHTMLAttributes<HTMLInputElement> & {
  wrapperClassName?: string;
}): JSX.Element
// Renders: <div.relative> <MdSearch (absolute icon)/> <Input h-7 pl-7 text-xs /> </div>

// Hook — manages search state + memoized flat-list filtering
function useTextFilter<T>(opts: {
  items: T[];
  accessor: (item: T) => string;
}): {
  query: string;
  setQuery: (q: string) => void;
  filtered: T[];   // items filtered by query (pass-through when empty)
  isActive: boolean;
}

// Utility — recursive tree filter (prunes branches with no matches)
function filterTree<T>(
  nodes: T[],
  predicate: (node: T) => boolean,
  getChildren: (node: T) => T[],
  rebuild: (node: T, children: T[]) => T,
): T[]

// Utility — depth-first ID collection (for auto-expand after tree filter)
function collectAllIds<T>(
  nodes: T[],
  getId: (node: T) => string,
  getChildren: (node: T) => T[],
): string[]
```

`filterTree` + `collectAllIds` are generic over node shape via callbacks — no domain type imports. `useTextFilter` returns filtered items directly (saves a `useMemo` in the consumer). Tree consumers use `filterTree` in their own `useMemo` since the tree rebuild is custom logic.

## Consumer Refactors

### A. `plugins/debug/plugins/queue/web/components/queue-view.tsx`

- **Delete** local `FilterChip` component
- **Import** `FilterChip, useChipFilter` from `@plugins/primitives/plugins/filter-chips/web`
- **Replace** `useState<JobState | "all">("all")` → `useChipFilter<JobState | "all">("all")`
- **Replace** manual `.filter()` → `chipFilter.matches(r.state)` in the existing useMemo
- **Replace** `active={filter === "all"}` / `onClick={() => setFilter("all")}` → `chipFilter.value` / `chipFilter.setValue`

### B. `plugins/debug/plugins/claude-cli-calls/web/components/calls-view.tsx`

- **Delete** local `FilterChip` and `FilterGroup` components
- **Import** `FilterChip, FilterGroup, useChipFilter` from `@plugins/primitives/plugins/filter-chips/web`
- **Replace** two `useState` → two `useChipFilter` calls (one for model, one for source)
- **Replace** the AND-logic filter → chain `modelChip.matches()` and `sourceChip.matches()`

### C. `plugins/apps/plugins/forge/plugins/catalog/web/components/catalog-view.tsx`

- **Replace** inline category tab `<button>` elements → `FilterChip` from `@plugins/primitives/plugins/filter-chips/web`
- **Replace** bare `<input>` → `SearchInput` from `@plugins/primitives/plugins/search/web`
- Category tab behavior (reset filter on switch, count badge) stays as consumer logic — FilterChip just provides the visual

### D. `plugins/apps/plugins/forge/plugins/publish/web/components/plugin-tree.tsx`

(Moved from `plugin-meta/publish/` after rebase)

- **Delete** local `filterNode()` and `collectAllIds()` functions
- **Delete** `import { Input } from "@/components/ui/input"`
- **Import** `SearchInput, filterTree, collectAllIds` from `@plugins/primitives/plugins/search/web`
- **Replace** `<Input>` → `<SearchInput wrapperClassName="px-3 py-2.5 border-b" placeholder="Filter plugins" />`
- **Replace** `filterNode` calls → `filterTree(plugins, n => n.name.toLowerCase().includes(needle), n => n.children, (n, ch) => ({ ...n, children: ch }))`
- **Replace** `collectAllIds(filtered)` → `collectAllIds(filtered, n => n.hierarchyId, n => n.children)`

### E. `plugins/conversations/.../blocked-by/web/components/blocked-by-button.tsx`

- **Delete** `useState("")` for search and the bare `<input>` element
- **Import** `SearchInput, useTextFilter` from `@plugins/primitives/plugins/search/web`
- **Split** the `availableConvs` useMemo: first filter by dep exclusion, then pass to `useTextFilter`
- **Replace** bare `<input>` → `<SearchInput wrapperClassName="mb-1.5" placeholder="Search conversations..." />`

### F. `plugins/conversations/.../blocking/web/components/blocking-button.tsx`

- Identical refactor to blocked-by (E) — same pattern, same imports

## Not refactored (intentional)

- **`forge/catalog/categories/*.tsx`** (5 table files) — These receive `filter` as a prop from catalog-view and apply `toLowerCase().includes()` per-field. The filtering is field-specific per table. The `SearchInput` component doesn't help (no input rendered), and `useTextFilter` doesn't fit (state lives in parent). The one-liner `toLowerCase().includes()` doesn't warrant a utility.
- **`primitives/avatar/avatar-picker.tsx`** — Uses a dedicated `fullSet.search(query)` function, not raw string matching. Different enough to leave alone.
- **`reorder/dnd-components.tsx`** — Disabled stub `<Input placeholder="Search..." disabled />`. Once enabled, should use `SearchInput`.

## Implementation Order

1. Create `filter-chips` sub-plugin (package.json, barrel, component + hook)
2. Create `search` sub-plugin (package.json, barrel, SearchInput + useTextFilter + filterTree)
3. Refactor queue-view.tsx (filter-chips consumer)
4. Refactor calls-view.tsx (filter-chips consumer)
5. Refactor catalog-view.tsx (filter-chips + SearchInput consumer)
6. Refactor plugin-tree.tsx (search consumer)
7. Refactor blocked-by-button.tsx (search consumer)
8. Refactor blocking-button.tsx (search consumer)
9. `./equin build` and verify all surfaces work

## Verification

1. `./equin build` — must compile cleanly
2. Open Debug > Jobs Queue — filter chips toggle between states, counts display correctly
3. Open Debug > Claude CLI Calls — model + source chips filter independently, AND-logic works
4. Open Forge > Catalog — category tab-chips switch views, text filter narrows tables
5. Open Forge > Publish — text filter prunes tree, auto-expand shows matches, clear restores original
6. Open a conversation > Blocked By popover — search filters conversations by title
7. Open a conversation > Blocking popover — same search behavior
8. `./equin check` — plugin boundaries pass (imports use correct barrel paths)
