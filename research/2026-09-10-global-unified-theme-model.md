# One theme per app: a first-class `Theme`

## Context

The page mental model (block `block-0b612677-…`) says: an app is themed by a
**theme**, a theme is a collection of tokens (colors, typography, …), themes come
from tweakcn or are custom (defined by apps), and they all appear in one THEME
DataView.

The code has no such object. What paints an app is **11 separate per-group
settings** (`plugins/ui/plugins/tokens/plugins/<group>/shared/config.ts`, each
`{ preset, overrides }`, scope `app`), chosen, stored and inherited one by one:

- **Inheritance leaks one group at a time.** config_v2 falls back to the desktop's
  document *per descriptor* when an app has no doc of its own. An app that pins 10
  groups still inherits the 11th from the user's machine. That is how the website
  rendered in the desktop's system font. The `tokens:app-theme-pins-total` check
  (`plugins/ui/plugins/tokens/check/index.ts`) only covers this up, by forcing
  11 pin files per app.
- **"Picking a theme" only copies settings.** `GlobalPresetPicker`
  (`theme-customizer/web/components/theme-customizer.tsx:51`) and community-browser's
  `useApplyThemePresets` loop over the groups and write each one's `preset`. The
  `globalPreset` they record is never read. On main it says `default` for every app,
  while 7 apps actually show 7 different tweakcn themes.
- **Themes are partial.** `GlobalPreset.groups` is `Partial<…>` (it leaves out
  density and rich-text). tweakcn themes fill only 6 groups, so applying one keeps
  whatever type scale or density the previous theme left.
- **The website's theme is scattered.** It is 6 per-group presets that happen to
  share the id `equin`, plus 11 pin files under `config/ui/tokens/*/@app/website/`.

**Outcome:** a `Theme` becomes a real value. Each scope (the desktop, or one app)
stores **one** choice: which theme. tweakcn imports, app-provided themes and user
custom themes all go through the same registry and are listed in one DataView. The
Ocean/Warm presets and the check are deleted. The check can't be satisfied or
broken any more: an app can't pin part of a theme.

### Decisions (user)

- **Edits copy into a custom theme.** Code and tweakcn themes are read-only.
  Editing one creates a custom theme that `extends` it, and selects it.
- **Start fresh.** Existing runtime theme choices are not migrated. Every app
  resets to Default and the user re-picks.
- **Group presets stay as editor shortcuts**, not as settings. This covers shape
  sharp/rounded/pill, shadow none/elevated/heavy, density comfortable/cozy/compact,
  and color-adjust grayscale/vibrant/…
- **One Theme DataView with views.** The default view is "My themes"; a
  "Community" view shows the tweakcn catalog.

## What using it looks like

```ts
// plugins/apps/plugins/website/plugins/shell/web/internal/theme.ts
export const equinTheme = defineTheme({
  id: "equin",
  label: "equin",
  fragments: [
    colorPaletteGroup.fragment({ light: {...}, dark: {...} }),
    chartGroup.fragment({ light: {...}, dark: {...} }),
    typeScaleGroup.fragment(both({ fontSizeDisplay: "4.875rem", ... })),
    densityGroup.fragment(both({ padCard: "2.125rem", ... })),
    shapeGroup.fragment(both({ radius: "0.6944rem" })),
    fontFamilyGroup.fragment(both({ fontSans: "'Inter Variable', sans-serif", ... })),
  ],
});
// shell/web/index.ts
ThemeEngine.Theme(equinTheme),
```

```jsonc
// config/ui/theme-engine/@app/website/theme.jsonc — the ONLY per-app theme file
{ "theme": "equin" }
```

A group the theme doesn't mention (sidebar, categorical, rich-text, shadow) uses
**that group's schema defaults**, which live in git. It never uses another scope's
runtime setting. So a partial theme is safe by construction.

For the user: open the customizer (or the quick-theme popover) and a Theme DataView
shows "My themes": Default, equin, the tweakcn themes they have, and their custom
themes. They click one to select it for the current scope. The "Community" view
lists the 522 catalog themes, and clicking one saves and selects it. If they change
a color while on "Catppuccin", a "Catppuccin copy" custom theme appears in "My
themes" and becomes the selection.

## Design

### 1. Core types — `ui/theme-engine/core`

`define-token-group.ts`: `defineTokenGroup` returns a descriptor with a typed
fragment builder, so a wrong group or token name is a `tsc` error. It also exports
`both(values)`, the mode-independent helper the website hand-rolls today.

```ts
interface TokenGroupFragment<T extends TokenGroupSchema = TokenGroupSchema> {
  groupId: string;
  light: Partial<{ [K in keyof T]: string }>;
  dark: Partial<{ [K in keyof T]: string }>;
  meta?: Record<string, unknown>;  // editor-only (shadow's params); never read by the resolver
}
descriptor.fragment({ light, dark, meta? }): TokenGroupFragment<T>
```

New `theme.ts`:

```ts
type ThemeId = string;
type ThemeSource = "built-in" | "tweakcn" | "custom";
interface Theme {
  id: ThemeId; label: string; source: ThemeSource;
  extends?: ThemeId;
  fragments: TokenGroupFragment[];   // sparse, at most one per group
  colorAdjust?: ColorAdjustment;     // hue/saturation/lightness, mode-independent
}
defineTheme({ id, label, fragments, colorAdjust? }): Theme   // source "built-in"
```

New `resolve-theme.ts` (pure, `*.test.ts` beside it):
`resolveTheme(id, themesById, groups) → { groups: Record<groupId, {light, dark}>, colorAdjust }`.

- Start every registered group at its schema defaults.
- Walk the `extends` chain root → leaf, applying each theme's fragments, so the
  leaf wins. Only non-empty values count, reusing `mergeGroupValues`
  (`theme-engine/web/internal/merge-group-values.ts`, moved to core).
- `colorAdjust`: the leaf's value if set, else the nearest ancestor's, else
  `{0, 1, 1}`.
- An `extends` cycle or a missing `extends` target **throws**. Both are prevented
  at write time (§4), so a throw here means a bug, not bad user data.
- A persisted fragment for a group that is no longer registered is skipped and
  reported through report-sink. Token keys unknown to the schema are dropped the
  same way.

`config.ts`: rename the descriptor so old docs become orphans rather than config
conflicts. With the old name, config_v2 would flag every existing runtime doc as
out of date. With a new name, they are simply orphans, which
`config_v2/server/internal/orphan-audit.ts` lists and never deletes. This fits the
start-fresh decision.

```ts
export const themeEngineConfig = defineConfig({
  name: "theme", scope: "app",
  fields: {
    theme: dynamicEnumField({ default: "default", label: "Theme" }),
    colorMode: enumField({ default: "system", options: ["light","dark","system"], label: "Color mode" }),
  },
});
```

### 2. Slots and hooks — `ui/theme-engine/web`

```ts
interface TokenGroupContribution { id; label; descriptor }   // no usePresets / configDescriptor / resolve
interface VariantGroupContribution { id; componentLabel; component } // `selects` removed: only component variants remain

type ThemeSourceContribution =
  | { kind: "resident"; id: string; useThemes: () => Theme[] | undefined }           // undefined = still loading
  | { kind: "browse"; id: string; useEntries: () => ThemeSourceEntry[] | undefined;
      adopt: (entryId: string) => Promise<ThemeId> };                                // save it, return its id
interface ThemeSourceEntry { id; label; tags: string[]; preview: {light; dark}; savedThemeId?: ThemeId }

ThemeEngine = {
  VariantGroup, TokenGroup,
  Theme: defineSlot<Theme>(),                   // code themes: Default (here), equin (website)
  ThemeSource: defineSlot<ThemeSourceContribution>(),
};  // GlobalPreset, PresetSource, ColorTransform: deleted

useThemes(): { pending: true } | { pending: false; themesById: ReadonlyMap<ThemeId, Theme> }
  // = Theme slot ∪ every resident source; any source still loading ⇒ pending
  // (same union as today's useTokenGroupPresets, slots.ts:75)
useResolvedTheme(scopeId): { pending: true } | { pending: false; theme: ResolvedTheme; missing?: ThemeId }
useThemeSelections(): { scopeId: string | undefined; themeId: ThemeId }[]   // desktop + every scope with its own doc
```

Theme-engine names no source. Themes arrive through the `ThemeSource`
contributions, the same way `PresetSource` works today.

### 3. Painting — `theme-injector.tsx`

- `ThemeInjector` and `ScopedAppTheme` each call `useResolvedTheme(scopeId)` once,
  and pass one group's `{light, dark}` into each `GroupStyle`. `GroupStyle` no longer
  reads config or presets.
- **One ownership check per scope:** `useScopeMembership(themeEngineConfig, scopeId)`
  replaces the per-group check at `:105`. A scope with its own doc emits blocks for
  every group. A scope without one emits nothing and inherits `:root` whole.
- `ColorAdjustContext` is fed from `resolved.colorAdjust`. `WithAdjustment` and
  `colorTransforms[0]` are deleted.
- **Unchanged:** style ids (`theme-engine-<group>`, `theme-scope-<token>-<group>`),
  `assertComplete`, `renderGroupBlock`, `transformValues`, and the paint-cache
  aggregator, envelope and replay script in `web-core/web/index.html`. They only see
  style ids and CSS text. Keep `GroupStyle`'s string-keyed memo; it is what prevents
  the boot flicker.
- **Pending:** if any resident source is still loading, inject nothing. This is
  today's behaviour, and it keeps the replayed before-first-paint CSS on screen.
- **Selected theme doesn't exist:** paint Default for that scope, file a report, and
  have the Theme picker show a "missing theme" state. This is a loud degrade, not a
  silent one. The delete rule in §4 makes it reachable only by hand-editing a file.

### 4. Saved themes — new `ui/theme-engine/plugins/saved-themes`

This one table holds tweakcn imports and custom themes. It is a sub-plugin that
names no source, so both tweakcn and the editors can depend on it without cycles.

- `server/internal/tables.ts`: a `saved_themes` table with columns `id` (`tweakcn:<id>`
  or `custom:<uuid>`), `source`, `externalId` (partial unique, for idempotent tweakcn
  re-import), `label`, `extends`, `fragments` (a `parsedJson` fragment schema),
  `colorAdjust`, `createdAt`, and `updatedAt`.
- Endpoints (plain `defineEndpoint`, like tweakcn's today — a small table, not a
  live-state collection):
  - `GET /api/saved-themes` → `Theme[]`
  - `POST /api/saved-themes` → create; upserts on `externalId`, and validates that
    `extends` resolves
  - `PATCH /api/saved-themes/:id/fragment` → `{ groupId, light, dark, meta? }`
  - `PATCH /api/saved-themes/:id/color-adjust`
  - `PATCH /api/saved-themes/:id` → `{ label }`
  - `DELETE /api/saved-themes/:id?reassign=true` → refuses with 409 plus the list of
    scopes using the theme. With `reassign`, it first sets those scopes to
    `default` (config_v2 `setConfig`), then deletes.
  - Mutations invalidate the list (`useEndpointMutation({ invalidates })`).
- `web/boot.ts`: a `Core.Boot` + `hydrateEndpoint` pair, a straight move of
  `tweakcn/web/boot.ts`. It makes saved themes resolvable on the first paint.
  `web/index.ts` contributes `ThemeEngine.ThemeSource({ kind: "resident", id: "saved" })`.
- `web/use-edit-theme.ts` is **the one place edits land**:
  `useEditTheme(scopeId) → { setTokens(groupId, {light?, dark?}), setColorAdjust(patch), fillFrom(groupId, fragment) }`.
  - If the scope's current theme isn't `custom`, it first creates
    `{ source: "custom", label: "<base> copy", extends: current, fragments: [] }`,
    selects it for this scope, then applies the edit.
  - Every editor section calls this; none calls `useSetConfig` on a token group.
- Server imports only config_v2 and theme-engine core.

### 5. Token groups — pattern for the 10 groups + color-adjust

For each `plugins/ui/plugins/tokens/plugins/<group>/` (color-palette is
representative):

- **Delete:** `shared/config.ts` and `web/internal/config.ts`; the
  `ConfigV2.WebRegister`/`Register` and the `DynamicEnum.Options` for `preset`; the
  `VariantGroup` "tokens" picker (`*-picker.tsx`, plus `color-palette-header-dots.tsx`
  if it only serves the picker); and the `<Group>.Preset` slot (the website no longer
  contributes to it).
- **Shrink:** the `TokenGroup` contribution to `{ id, label, descriptor }`.
- **Sections** (`*-section.tsx`, and the shared `theme-customizer/.../token-row.tsx`)
  read the resolved theme for display and write through `useEditTheme`. "Reset" on a
  token clears the custom theme's value, so the value inherited through `extends`
  shows again.
- **Shortcuts:** `web/presets.ts` → `web/shortcuts.ts`, a plain list of named
  fragments. The section shows a "Fill from…" menu that calls `fillFrom`. Kept for
  shape, shadow, density and color-adjust. Deleted for color-palette (default ==
  schema defaults; Ocean/Warm retired), sidebar-palette (Warm retired), and chart,
  categorical, font-family and type-scale (only a `default` that equals the schema).
- **shadow:** remove `resolve` from the runtime. A fragment stores the plain tier
  values, which is what tweakcn already supplies. The param sliders compute tiers with
  `buildShadowTiers` (`shared/shadow-map.ts`) and store the params in
  `fragment.meta` so they can be edited again.
- **color-adjust:** becomes `Theme.colorAdjust`. Delete its config, its
  `ColorTransform` contribution and its picker. Its section edits through
  `setColorAdjust`, and its 12 presets become shortcuts.
- **rich-text-palette:** just a group with schema defaults. Delete its config.
- **google-fonts loader** (`font-family/plugins/google-fonts/.../google-fonts-loader.tsx`):
  union the font families of `useResolvedTheme` over `useThemeSelections()`. This
  fixes today's bug where per-app fonts are never loaded, because the loader reads
  only the unscoped config.

### 6. tweakcn becomes an importer

- `core/convert.ts` returns `TokenGroupFragment[]`-shaped literals. It doesn't call
  each group's builder, which would add 6 imports into tweakcn core. The typed
  builder matters for hand-written themes. The converter stays covered by its own
  tests and the `assertComplete` runtime check.
- The URL import and community apply (`handle-import.ts`, `handle-apply.ts`) convert
  the theme, then call saved-themes' create with `source: "tweakcn"` and `externalId`.
- **Delete:** `server/internal/tables.ts` (`tweakcn_themes`), `handle-list.ts`,
  `handle-delete.ts`, `web/boot.ts`, and the `PresetSource` contribution. Start fresh
  means imported rows are not carried over. A catalog theme is one click to re-add.
- `community-browser/web/index.ts` contributes
  `ThemeEngine.ThemeSource({ kind: "browse", id: "community", useEntries, adopt })`.
  `useEntries` maps `getCatalog()` rows; `savedThemeId` is set when the catalog id is
  already saved, so the row isn't shown twice. `adopt` calls apply and returns the
  saved id.
- **Delete** `community-browser-section.tsx`, `quick-theme-section.tsx` and
  `use-apply-catalog-theme.ts`. Move the card and swatch rendering into the gallery
  (§7), reading `preview`.
- `import-by-url.tsx` stays as its own small `ThemeCustomizer.Section`, minus its
  list of imported rows. Those rows now appear in "My themes".

### 7. The Theme DataView — new `ui/theme-engine/plugins/theme-gallery`

- `defineDataView("theme-engine.themes")` over rows built from `useThemes()` and
  every browse source's `useEntries()`, with already-saved catalog entries dropped.
- Row fields: name (primary), source (built-in / tweakcn / custom / community),
  tags, `saved` (resident vs browse), "used by" (from `useThemeSelections()`), and a
  swatch preview (the `color-palette` slice of the resolved theme, or `preview` for a
  catalog entry).
- Activating a row:
  - Resident row → `setConfig(themeEngineConfig, "theme", id, { scopeId })`.
  - Catalog row → `await source.adopt(entryId)`, then select the returned id.
  - `scopeId` comes from the surrounding `ThemeScopeProvider`, as today.
- Item actions on custom themes: rename, delete (confirm dialog listing the scopes
  that will fall back to Default).
- Views, authored in `config/ui/theme-engine/theme-gallery/theme-engine.themes.jsonc`
  (the same saved-filter shape as today's `config/ui/tweakcn/community-browser/*.jsonc`):
  - **My themes** (default): `saved = true`, gallery.
  - **Community**: `source = community`, gallery, with tag filters. It carries over
    the old "Professional" view as a filter.
  - Needs the DataView's authored-override review marker cleared (`config:overrides-authored`).
- Mounted in two places:
  - `ThemeGalleryPicker` replaces `GlobalPresetPicker` at the top of the customizer.
  - A `QuickTheme.Section` (list view) replaces community-browser's quick section.
  - The quick-theme panel drops its `selects === "component"` filter
    (`quick-theme-panel.tsx:25-46`).
- "Customize for <App>" (`theme-customizer.tsx` ~`:225`, `quick-theme-panel.tsx:78`)
  still checks `themeEngineConfig` ownership. Forking an app now copies one doc.

### 8. Website and the check

- `shell/web/internal/theme-presets.ts` → `theme.ts` exporting `equinTheme`. The 6
  value blocks stay as-is and are wrapped in `<group>.fragment(...)`. `web/index.ts`
  contributes `ThemeEngine.Theme(equinTheme)` instead of 6 `.Preset(...)` calls.
- Config:
  - Delete `config/ui/theme-engine/@app/website/config.jsonc`.
  - Add `config/ui/theme-engine/@app/website/theme.jsonc` = `{ "theme": "equin" }`,
    with a `// @hash` taken from the new `theme.origin.jsonc` the build generates.
  - Delete all of `config/ui/tokens/*/@app/website/`. The per-group
    `config.origin.jsonc` files go away when `./equin build` runs without
    their descriptors.
- Delete `plugins/ui/plugins/tokens/check/` (`tokens:app-theme-pins-total`).
- Delete the 3 `GlobalPreset`s in `plugins/ui/plugins/tokens/web/index.ts`.
- Docs: rewrite `plugins/ui/plugins/tokens/CLAUDE.md` ("An app owns its theme…" →
  "an app selects one theme"), the website `CLAUDE.md` and `shell/CLAUDE.md` theme
  paragraphs, the theme-engine `CLAUDE.md` prose, and
  `.claude/skills/theme/SKILL.md` (no Default/Ocean/Warm; theme = one selection).

## Implementation order

All of this lands in one branch and one push.

1. Core: `Theme`, `defineTheme`, `.fragment()`/`both()`, `resolveTheme` + tests.
   Move `mergeGroupValues` to core. Purely additive.
2. `saved-themes` sub-plugin (table, endpoints, boot, resident source,
   `useEditTheme`). Build with `--migration-name add-saved-themes`.
3. theme-engine switch-over:
   - Rename the config and slots.
   - Add the Default code theme.
   - Rewrite `theme-injector.tsx`.
   - Migrate the 10 token groups and color-adjust (§5).
   - Fix the fonts loader.
   - Move the website to `equinTheme` and its one config file.
   - Delete the check and the global presets.
4. tweakcn → importer, community-browser → browse source. Drop `tweakcn_themes` in a
   **second** build: dropping it in the same generation as the new table can trigger
   drizzle-kit's interactive "is this a rename?" prompt.
5. `theme-gallery` sub-plugin and its config views. Wire it into the customizer and
   quick-theme.
6. Docs + skill. `./equin build`, which regenerates origins, plugin docs and
   registries.

## Critical files

- `plugins/ui/plugins/theme-engine/core/{config.ts, define-token-group.ts}` + new `theme.ts`, `resolve-theme.ts`
- `plugins/ui/plugins/theme-engine/web/{slots.ts, index.ts, components/theme-injector.tsx}`
- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/{theme-customizer.tsx, token-row.tsx}`
- `plugins/ui/plugins/theme-engine/plugins/quick-theme/web/components/quick-theme-panel.tsx`
- New: `plugins/ui/plugins/theme-engine/plugins/{saved-themes, theme-gallery}/`
- `plugins/ui/plugins/tokens/plugins/<group>/{shared/config.ts, web/index.ts, web/presets.ts, web/components/*-section.tsx}` (pattern × 11)
- `plugins/ui/plugins/tokens/plugins/shadow/{web/index.ts, shared/shadow-map.ts}`
- `plugins/ui/plugins/tokens/plugins/font-family/plugins/google-fonts/web/internal/google-fonts-loader.tsx`
- `plugins/ui/plugins/tokens/{web/index.ts, check/index.ts, CLAUDE.md}`
- `plugins/ui/plugins/tweakcn/{core/convert.ts, server/**, web/**}`, `tweakcn/plugins/community-browser/{server/internal/handle-apply.ts, web/**}`
- `plugins/apps/plugins/website/plugins/shell/web/{index.ts, internal/theme-presets.ts}`
- `config/ui/theme-engine/**`, `config/ui/tokens/**`

## Verification

- **Tests** (`./equin test plugins/ui`):
  - New `resolve-theme.test.ts`:
    - A group the theme doesn't mention gets schema defaults.
    - A leaf theme beats its `extends` parent.
    - Empty values don't override.
    - `extends` cycles and missing targets throw.
    - `colorAdjust` inheritance.
    - An unknown group's fragment is skipped.
  - Moved `merge-group-values.test.ts`.
  - `paint-cache-aggregator.test.ts` stays unchanged and must still pass.
  - tweakcn `convert` output shape.
  - saved-themes: `extends` validated on write; 409 vs `reassign` on delete.
- **Checks:** `./equin check`. Watch plugin-boundaries (new edges
  tokens/* → saved-themes, tweakcn → saved-themes; no cycles),
  registrations-paired, origins in sync, `config:overrides-authored`, data-views in
  sync. `tokens:app-theme-pins-total` must be absent from `--list`.
- **In the app**, after `./equin build`, with the screenshot tool
  (`./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts`):
  1. `--path /website`, dark and light. Compare against the current site: same
     colors, type, spacing, and the Inter font.
  2. Desktop at `/`: Default theme, no flash on reload (warm cache).
  3. Customizer: the Theme DataView shows "My themes" (Default, equin) and
     "Community". Click a community theme; it appears in "My themes" and is applied.
  4. "Customize for <App>", then change one color. A "<theme> copy" custom theme
     appears and is selected for that app only. The desktop's `:root` block is
     unchanged, and the app's scoped block changed.
  5. Delete that custom theme. The confirm dialog names the app; afterwards the app
     shows Default.
  6. An app on a tweakcn theme with a Google font. The font loads when the app is
     focused (the loader bug is fixed).
