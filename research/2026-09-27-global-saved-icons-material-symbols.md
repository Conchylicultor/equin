# Saved icons on Material Symbols

## Context

The code's icons moved to Material Symbols
(`research/2026-09-27-global-material-symbols-icons.md`, `plugins/ui/plugins/icons`).
Icons users pick and save did not. They still store a classic Material Icons key
(snake_case, `add_circle_outline`) **plus** a drawing (`SvgNode[]`) extracted
from `react-icons/md`. Two consequences:

- they draw the old glyph and ignore the per-app icon theme, since a stored
  drawing is one fixed style;
- `primitives/icon-picker` browses and generates from `react-icons/md`, so it
  keeps the package (and a lint exemption) alive.

Goal: one icon set. A saved icon is **a Material Symbols name and nothing
else**, drawn by `<Icon>` like every code icon, so it follows the scope's theme.
Then `react-icons`, the `SvgNode` format and the exemption go.

## Inventory (what stores a saved icon today)

| Store | Shape today | Writer | Readers |
|---|---|---|---|
| `agents` table (`conversations/agents/server/internal/tables.ts`) | `icon text`, `icon_color`, `icon_svg_nodes text` (JSON) | `agent-detail.tsx` → `handle-create/update.ts` | `agent-avatar-row`, `agent-avatar-title-prefix`, `agents-list` (DataView `avatarFieldDef`); boot backfill `backfill-svg.ts` |
| `avatarField` config (`fields/avatar/plugins/config`) → `AvatarSpec {icon,color,svgNodes}` | conversation-category `categories[].items[].avatar`, preprompts `preprompts[].icon` | avatar renderer → `AvatarPicker` | `category-avatar-row`, `preprompt-glyph` (own `renderSvgNodes`); `svgNodes` filled at read by `registerFieldResolver("avatar")` (`primitives/avatar/server/internal/register-resolver.ts`) |
| `conversations_ext_preprompt.icon` (`conversation-preprompt/shared/schemas.ts`) | jsonb `AvatarSpec` snapshot | set at launch | preprompt chip |
| `page_blocks.data` type `page` / `callout` (`page/editor/core/schemas.ts`, `page/callout/core/callout-block.ts`) | `icon`, `iconSvgNodes` | `page-icon-button.tsx`, `callout-appearance.tsx` | `PageIcon` (one renderer, ~12 call sites), `links/server/internal/resources.ts` (`data -> 'iconSvgNodes'`), `content-search/reindex-page.ts` (search metadata) |
| `entity_versions` (pages history source) | `PageContentSnapshot` embeds the page's and callouts' `data` | history engine | `page-version-preview.tsx` |
| Code default | `DEFAULT_AGENT_AVATAR` (`primitives/avatar/web/internal/default-avatar.ts`): `precision_manufacturing` + inlined nodes | — | agent fallbacks |
| Committed config | `config/conversations/conversation-category/config.jsonc` (`question_mark`, `star_outline`, …) | — | — |

## Decisions

1. **Store the name only.** Every `svgNodes` / `iconSvgNodes` / `icon_svg_nodes`
   field is deleted. The drawing was a cache so display surfaces didn't ship
   the react-icons bundle; the sprite system already solves that, and a stored
   drawing is exactly what makes the theme impossible (it would take 12 copies,
   one per style key).
2. **Names are kebab-case `SymbolName`s**, validated on write. The shared
   decoded type is a server-checked `SavedSymbolName` (a `parsedText` /
   zod schema whose parse checks membership in the installed sets, the same
   `hasIcon` lookup the sprite builder uses), so an unknown name cannot be
   stored. Web code receives it already branded.
3. **Runtime symbols in `ui/icons`.** Code names stay literal and
   manifest-collected (untouched). Saved names get their own constructor,
   `runtimeSymbol(name: SavedSymbolName): IconRef` (new arm
   `{ kind: "runtime-symbol", name }`), exempt from `icons/literal-icon-name`
   by construction, since it's a different function. `<Icon>` draws it from an
   on-demand symbol store:
   - **Server** (`ui/icons/plugins/sprites`): `GET /api/icons/symbols/:hash/:styleKey?names=a,b,c`
     returns `<symbol>`s for those names, resolved through the existing
     `resolveSymbol` (nearest-style fallback included). Names are sorted, so
     the URL is content-addressed and cached immutably. Symbols are memoized
     per (styleKey, name); the parsed sets are shared with the sprite build.
   - **Web:** `<Icon>` on a runtime symbol registers (styleKey, name) with a
     loader that batches every request made in a frame into one fetch and
     appends the result to the sprite sheet (`sprite-store`). While a
     non-default style's symbol is loading, `<Icon>` draws the **default
     style's** symbol for the same name, exactly as code icons do while a
     style sprite loads. A theme switch therefore never blanks a saved icon.
     Only a name with no drawing in any style yet (not resident, never
     fetched) renders an empty box at its final size, which is a loading
     state. A failed fetch throws to the error boundary, like `IconSpriteHost`.
   - **Theme changes are live:** the stored value is only a name, and
     `<Icon>` resolves the style key from the scope at render, so avatars and
     page icons restyle as the theme changes. There is no backfill and nothing
     stored per style.
   - **Boot, no pop-in:** a server registry `defineSavedIconSource({ id, names, tables })`
     (sprites server barrel; collection-consumer: sprites knows no source).
     It feeds a resident `icons.saved-sprites` value
     (`preload: "boot-and-keep"`): the default style keys' drawings for every
     name the sources report, recomputed on their tables' change feed. Sources:
     agents (`SELECT DISTINCT icon`), pages (`DISTINCT data->>'icon'` over
     `page_blocks` of type page/callout), conversation-category + preprompts
     config (the config handle's change signal). History previews, the picker
     grid and non-default styles use the on-demand path.
4. **The picker browses Symbols** (`primitives/icon-picker`, same plugin, same
   `<IconPicker value onSelect>` contract, but `onSelect(name: SavedSymbolName)`).
   - **Data:** vendored Google Material Symbols metadata (name → categories,
     tags, popularity; `fonts.google.com/metadata/icons`), trimmed to `SymbolName`.
     It is generated by `scripts/gen-symbols-metadata.ts` and guarded by an
     in-sync check hashing the file + the iconify package version, replacing
     `icon-svg-map-in-sync`. It's needed because Iconify's `metadata.json` has
     categories but no tags, and tags carry search ("robot" → `smart-toy`).
   - **Grid:** `virtual-rows` over categories, each cell `<Icon icon={runtimeSymbol(n)}/>`,
     so only visible rows load, through the same on-demand path, in the scope's
     theme. The ~630 KB `ICON_SVG_MAP` goes away.
   - `MdClose` / `MdSearch` → `symbol("close")` / `symbol("search")`.
5. **Classic → Symbols mapping is total and committed.** Every one of the 2 160
   classic keys (not just the ones on this machine: every clone migrates its
   own data) maps to a `SymbolName`. There are three tiers, in
   `primitives/icon-picker/shared/classic-symbol-names.ts` (generated once by
   script, then frozen):
   - snake → kebab when that is a `SymbolName` (1 965 keys);
   - suffix-stripped (`_outline`, `_outlined`, `_alt` → base) when the base
     exists, since the theme owns outline now (33 keys);
   - the 162 others (`email`, `phone`, `warning_amber`, `star_border`,
     `people`, `access_time`, …): matched by **codepoint**, because
     Google's classic and Symbols fonts share codepoints for the same glyph,
     joined from the two published `.codepoints` files at generation time.
     Any leftovers are hand-mapped in a small override table.

   A test asserts the table covers every classic key and every value is a
   `SymbolName`.
6. **Saved config migrates through a generic config-migration ledger**, not a
   read-time legacy decode. User config (`~/.singularity/state/config/<ns>/`)
   isn't in git, and relocate already solved "rewrite saved config once per
   namespace on build" (`applyPluginMoves`, `.plugin-moves-applied.json`,
   hash re-stamping). Generalize it into `config_v2`:
   `defineConfigMigration({ id, configId, apply(value) })`, applied by
   `deploy-namespace.ts` before git-config propagation and recorded per
   namespace. `applyPluginMoves` becomes the first client, the icon remap the
   second. The alternative (the avatar schema accepting classic keys forever)
   keeps the mapping table and a second spelling alive indefinitely.

## Migration

### 1. Runtime symbols + saved sources (`ui/icons`)
- `core`: `runtimeSymbol`, `SavedSymbolName` brand, the `runtime-symbol` arm.
- `sprites/server`: the symbols route, the `defineSavedIconSource` registry,
  and the resident `icons.saved-sprites`. `server` exports the
  `SavedSymbolNameSchema` (membership parse).
- `sprites/web`: on-demand loader + `useRuntimeSymbol`, and the sheet
  appending runtime symbols. `<Icon>` handles the new arm.
- Test: the batching loader (one fetch per frame, dedupe, in-flight reuse),
  the route (unknown name → 404, hash mismatch → 409).

### 2. Picker on Symbols
Metadata generator + check, a virtualized grid, `onSelect(name)`.
`AvatarPicker` (`primitives/avatar`) passes the name through.

### 3. Data migration
- **SQL, one custom migration** (`./equin build --custom-migration --migration-name remap_saved_icons_to_symbols`),
  created **before** the schema change so it gets the earlier timestamp (see
  the migrations CLAUDE.md "data migration before a schema change"):
  - `agents.icon` via `UPDATE … FROM (VALUES …) m(old,new)` (VALUES generated
    from the table);
  - `page_blocks.data` for `type IN ('page','callout')`:
    `jsonb_set(data - 'iconSvgNodes', '{icon}', to_jsonb(m.new))`;
  - `conversations_ext_preprompt.icon`: remap `icon`, drop `svgNodes`;
  - `entity_versions` of source `pages`: the same rewrite on the snapshot's
    page data and on every callout row inside it;
  - `search_documents` of pages: drop `iconSvgNodes` from metadata (reindex
    writes `icon`).

  Idempotent: a second run is a no-op when every mapped value is a fixed point
  (a value that is also a classic key maps to itself, e.g. `phone → call`,
  `call → call`). The table's test asserts this.
- **Schema:** drop `agents.icon_svg_nodes`; `PageDataSchema` /
  `CalloutBlockData` lose `iconSvgNodes` (strict parse: must follow the data
  migration); `AvatarSpec` = `{ icon: SavedSymbolName, color }`.
- **Config:** a config migration for `conversation-category` and `preprompts`
  (map `avatar.icon` / `icon.icon`, drop `svgNodes`). The committed
  `config.jsonc` is rewritten in the same diff.
- `DEFAULT_AGENT_AVATAR` → `{ icon: "precision-manufacturing", color: "violet" }`.

### 4. Consumers
- `Avatar` (`primitives/avatar/web/components/avatar.tsx`): `icon` renders
  `runtimeSymbol(icon)`; drop the `svgNodes` prop.
- `PageIcon` (`page/editor/web/components/page-icon.tsx`): takes `icon` and
  keeps its `symbol("description")` fallback. Every call site passes
  `data.icon`, and tsc lists them.
- `preprompt-glyph.tsx`: its private `renderSvgNodes` is deleted in favor of `<Icon>`.
- `links/server/internal/resources.ts`: project `data->>'icon'`.
  `links/core/schemas.ts` holds `icon`.
- `content-search/reindex-page.ts` + `pages-search.tsx`: `icon`.
- Agents: `endpoints.ts` / `schemas.ts` / handlers lose `iconSvgNodes`, and the
  `agent-*` components read `agent.icon`. `backfill-svg.ts` + its `onReady`
  call are deleted.
- Delete `registerFieldResolver("avatar")` (nothing left to resolve). If
  `fields/core/field-resolvers.ts` has no other registrant, delete it too.
- Delete the structural `SvgNode` mirrors (`fields/avatar/core`,
  `page/editor/core` `SvgNodeSchema`, `conversation-preprompt/shared`,
  `page/links/core`).

### 5. Removal
- icon-picker: `SvgNode`, `SvgIcon`, `extractSvgNodes`, `ICON_SVG_MAP`,
  `svgNodesToString` (+ test), `server/resolve-svg.ts`, `gen-icon-svg-map.ts`,
  `icon-metadata.json`, the `icon-svg-map-in-sync` check. The plugin keeps
  `web` + `shared` + `scripts` + `check`; `core`/`server` go if empty.
- `react-icons` out of root `package.json`; `INLINE_PACKAGES`
  (`web-artifacts/core/constants.ts`) empties (+ its tests); `ui-kit/components.json`
  `iconLibrary`.
- `icon-safety`: `no-react-icons` loses the icon-picker exemption (it stays as
  a guard); `no-namespace-react-icons` + `react-icons-source.isIconPicker` are
  deleted.
- `config/stats/commits/config.jsonc`: its stale `avatar/…/icon-metadata.json` entry.
- Docs: icon-picker `CLAUDE.md` rewritten; `ui/icons` `CLAUDE.md` gains
  "runtime symbols"; the parent plan's "out of scope" line points here.

## Reused
- `resolveSymbol` / `coveredStyles` / `resolveSymbolStyle` (`ui/icons/server`, `core/fallback.ts`), `buildSprite`, `sprite-store`, `IconSpriteHost`'s fetch + throw pattern.
- `serveValue` + change feed for the resident saved sprites; `defineTrashSource` / `defineHistorySource` registry idiom for `defineSavedIconSource`.
- `applyPluginMoves` (relocate) as the base of the config-migration ledger.
- `virtual-rows` for the picker grid; the precedent in `backfill_avatar_icon_aliases.sql` for key-remap SQL.

## Verification
1. `./equin check`: tsc (no `SvgNode` left, every `PageIcon`/`Avatar` site updated), eslint (`no-react-icons` with no exemption), picker-metadata in sync, migrations in sync, boundaries.
2. `./equin test`: mapping-table totality, loader batching, route, config-migration ledger (applied once, hash re-stamped), `callout-block` / `stored-block-data` / `parse-block-data` suites updated.
3. Migration on a fork of real data: `query_db` before/after. `agents.icon`, `page_blocks.data->>'icon'` (page/callout), preprompt snapshots and history snapshots all hold `SymbolName`s; no `iconSvgNodes` key remains; the classic-key count is 0.
4. `./equin build`, then screenshots: agents list, pages sidebar + breadcrumb, a callout, category avatars, preprompt chips at cold load. Saved icons are present at first paint (resident), with no empty boxes.
5. Theme: set an app to `rounded` / `filled` / `light`. Its saved icons (agent avatars, page icons) change with its code icons; another app's don't.
6. Picker: search "robot" finds `smart-toy`; scrolling loads rows; picking saves a kebab name and it renders everywhere.
7. Page history: an old version's preview shows its icon.
8. `rg "react-icons" -g '!research' -g '!node_modules'` returns only the lint rule and its test.
