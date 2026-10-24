# tweakcn Community Browser — Web UI

## Context

The community-browser plugin has server endpoints (`GET /api/tweakcn/community/catalog`, `POST /api/tweakcn/community/apply`) and a bundled `catalog.json` (~521 themes). It lacks a `web/` layer — there's no way to browse or apply catalog themes from the UI. This plan adds the web layer: a `ThemeCustomizer.Section` contribution rendering a browsable gallery with tag filter, search, and one-click apply.

## Files to Create

```
plugins/ui/plugins/tweakcn/plugins/community-browser/web/
  index.ts                              — PluginDefinition barrel
  components/
    community-browser-section.tsx       — root section: fetch, filter, grid, apply
    community-theme-card.tsx            — mini mockup card (color swatch + bars + name)
```

## 1. `web/index.ts` — Plugin Barrel

Contributes `ThemeCustomizer.Section` with id `"community-browser"`, label `"Community Themes"`. Same pattern as parent `tweakcn/web/index.ts`. No `PresetSource` needed — applying a catalog theme upserts it into `_tweakcnThemes`, which the parent's existing `PresetSource` already reads via `listTweakcnThemes`.

## 2. `community-browser-section.tsx` — Root Section

Receives `{ search: string }` from the ThemeCustomizer host.

### Data fetching

- `useEndpoint(getCatalog, {})` → fetches all 521 themes once
- `useEndpointMutation(applyCatalogTheme, { invalidates: [listTweakcnThemes] })` → apply mutation

### Tag extraction

`useMemo`: collect all unique tags from catalog, sort by frequency descending (most-used first). Prepend "All". Tags are stable — not filtered by search.

### Filtering (search + tag, AND logic)

```
search: name.toLowerCase().includes(q) || tags.some(t => t.toLowerCase().includes(q))
tag:    activeTag === "all" || theme.tags.includes(activeTag)
combined: both must pass
```

Section-level early return (matches TweakcnSection pattern):
```ts
const sectionMatchesSearch = search.length === 0 ||
  "community themes".includes(search.toLowerCase()) ||
  "community".includes(search.toLowerCase());
if (!sectionMatchesSearch && visible.length === 0) return null;
```

### Tag filter row

Horizontal scrollable chips using `FilterChip` from `@plugins/primitives/plugins/filter-chips/web`. Single-select via `useState<string>("all")`. Chips get `flex-shrink-0` to prevent wrapping, container is `overflow-x-auto`.

### Apply flow (replicates `TweakcnSection.handleApply`)

1. Click card → `applyMutation.mutate({ body: { themeId } })`
2. `onSuccess(savedTheme)`: fan out `fetchEndpoint(setConfigField, ...)` for each token group whose id is a key in `savedTheme.presets`, same as TweakcnSection lines 65-79
3. `invalidates: [listTweakcnThemes]` refreshes the parent section

Dependencies for handleApply: `ThemeEngine.TokenGroup.useContributions()`, `useConfigRegistrations()`, `fetchEndpoint`, `setConfigField`.

### Pending state

Track `applyingId: string | null` via useState. Set on mutate, clear on settle. Pass to cards so the clicked card shows loading state.

### Layout

```tsx
<div className="flex flex-col gap-3">
  {/* Tag chips row */}
  <div className="flex gap-1.5 overflow-x-auto pb-1">...</div>
  {/* Theme count */}
  <span className="text-xs text-muted-foreground">{visible.length} themes</span>
  {/* 2-column grid */}
  <div className="grid grid-cols-2 gap-2">
    {visible.map(theme => <CommunityThemeCard ... />)}
  </div>
</div>
```

## 3. `community-theme-card.tsx` — Card Component

Props: `{ theme: CatalogTheme; isPending: boolean; onApply: () => void }`

### Visual design (tweakcn-style mini mockup)

```
┌─────────────────────┐
│  bg color swatch    │  ← background color, flex row of 6 color bars
│  ▐▐▐▐▐▐            │     h-16, primary/secondary/accent/muted/border/card
├─────────────────────┤
│ Theme Name  curated │  ← name + optional badge
└─────────────────────┘
```

- Swatch area: inline `style={{ backgroundColor }}` using `cssVars.light.background` or `cssVars.dark.background` depending on dark mode
- 6 color bars: thin vertical rects (`flex-1 rounded-sm`) inside a `flex gap-1` row, each colored via inline style from the theme's vars (primary, secondary, accent, muted, border, card)
- Dark mode detection: `useDarkMode()` from `@plugins/primitives/plugins/syntax-highlight/web` — follows the ThemeCustomizer's mode selector live
- Card wrapper: `<button>` with `rounded-lg border overflow-hidden cursor-pointer hover:ring-1 hover:ring-primary/40 transition-all`
- "Curated" badge: only when `source === "registry"`, `text-[10px] uppercase tracking-wide bg-primary/10 text-primary rounded-full px-1.5`
- Pending: `opacity-50 cursor-wait`

### Why inline styles (not CSS variables)

The card previews the theme's *own* colors, not the page's current theme tokens. `cssVars` values are raw OKLCH strings (`"oklch(1.00 0 0)"`), so we use them directly as `style.backgroundColor`.

## Key Import Paths

| Import | From |
|--------|------|
| `getCatalog`, `applyCatalogTheme` | `../../core` (relative to section) |
| `listTweakcnThemes` | `@plugins/ui/plugins/tweakcn/core` |
| `ThemeEngine` | `@plugins/ui/plugins/theme-engine/web` |
| `ThemeCustomizer` | `@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web` |
| `useEndpoint`, `useEndpointMutation`, `fetchEndpoint` | `@plugins/infra/plugins/endpoints/web` |
| `useConfigRegistrations` | `@plugins/config_v2/web` |
| `setConfigField` | `@plugins/config_v2/core` |
| `FilterChip` | `@plugins/primitives/plugins/filter-chips/web` |
| `useDarkMode` | `@plugins/primitives/plugins/syntax-highlight/web` |
| `PluginDefinition` | `@plugins/framework/plugins/web-sdk/core` |
| `cn` | `@/lib/utils` |

## Verification

1. `./equin build` — plugin auto-discovered, no migration needed
2. Navigate to Theme settings → verify "Community Themes" section appears (collapsed by default)
3. Expand → grid of themed cards with actual colors rendered
4. Tag filter → click a tag → grid narrows to matching themes
5. Search → type in pane search → cards filter by name and tags
6. Click a card → theme applies immediately (CSS vars update live)
7. Check parent "Import from tweakcn" section → applied theme appears in imported list
8. Toggle dark mode → card previews switch to dark variants
