# icons

Every icon in code is a **Material Symbols** glyph, named as data and drawn in
the style its theme scope picks — or, in a scope whose icon family is Lucide,
as that symbol's Lucide counterpart (see "Lucide family"). Plan and rationale:
[`research/2026-09-27-global-material-symbols-icons.md`](../../../../research/2026-09-27-global-material-symbols-icons.md).

```ts
import { symbol, brand, type IconRef } from "@plugins/ui/plugins/icons/core"; // any runtime
import { Icon } from "@plugins/ui/plugins/icons/web";

const forumIcon = symbol("forum");         // { kind: "symbol", name: "forum" }
const githubIcon = brand("github");        // { kind: "brand",  name: "github" }
const tsIcon = seti("typescript");         // { kind: "seti",   name: "typescript" }

<Icon icon={forumIcon} className="size-4" />
<Icon icon={pinIcon} active={pinned} />    // the theme's active fill (filled by default)
```

## The rules

- **An icon is data.** A slot takes `icon: IconRef`; its host draws it with
  `<Icon icon={item.icon} …/>`. Never a component, never a variant: `Outline`,
  `Rounded`, filled/unfilled pairs are the theme's choice, or `active`'s.
- **Names.** `SymbolName` is the base name (kebab-case, as on
  fonts.google.com/icons) of every symbol drawn in AT LEAST ONE of the 12
  styles (3 shapes × 2 fills × regular/light), deprecated ones included (the
  classic `auto-awesome`, `insights`). An unknown name is a tsc error. A base
  is a key with its style suffix stripped only when the stripped name is itself
  a key, so `error-circle-rounded` stays a base and invents no `error-circle`.
- **Missing styles fall back** (`resolveSymbolStyle`, core): a style that
  lacks the name draws the nearest style that has it — keep the **fill** first
  (it carries `active`; a filled-only icon draws filled at rest), then the
  **weight**, then the **shape** (the requested one, else `default`). The
  sprite builder applies it, so `ms-<K>-<name>` in sprite K is already the
  resolved drawing and `<Icon>` has no fallback of its own; `symbolBody` (the
  release CLI's app icon) applies the same rule. `BrandName` is a Simple Icons slug;
  `LucideName` is a visible Lucide icon or alias. All three are generated into
  `core/symbol-names.generated.ts` by `scripts/gen-symbol-names.ts`; rerun it
  after upgrading an `@iconify-json/*` package (`icons:symbol-names-in-sync`).
- **Literal names only.** `symbol("…")` / `brand("…")` / `seti("…")` take a string literal,
  imported under their own name and only ever called
  (lint `icons/literal-icon-name`). The build scans those literals into the
  icon manifest (`codegen/core/icon-manifest-gen.ts`, a pre-barrel manifest;
  `icons:manifest-in-sync`), and the sprites ship exactly the manifest — a
  name the scan cannot see would draw an empty box. The manifest sits beside
  its one reader, `plugins/sprites/server/internal/icon-manifest.generated.ts`,
  not in `core/`: the CLI loads the core barrel (through this plugin's checks)
  in the process that regenerates the manifest, which would freeze it.
- `<Icon>` is an `<svg viewBox="0 0 24 24" width="1em" height="1em">` holding
  `<use href="#<id>">`, so `size-*` classes and `[&_svg]:…` rules size it as
  before. Hidden from assistive tech unless it has `title` / `aria-label` /
  `aria-labelledby`; every other svg prop passes through.

## How a style is chosen

The style axes are the `icons` token group
(`plugins/ui/plugins/tokens/plugins/icons`): `iconFamily` (material | lucide —
see "Lucide family"), `iconShape` (default | rounded |
sharp), `iconFill` (outline | filled), `iconActiveFill` (filled | outline),
`iconStroke` (regular = Material Symbols 400 | light = Material Symbols Light
300; not `iconWeight`, which `type-scale:closed-role-ladder` reads as a type
metric). Default: outline, filled when active. One combination is a **style key**
(`default-outline-400`); a symbol's sprite id is `ms-<styleKey>-<name>`, a
brand's `si-<name>`.

**This plugin knows no theme — on purpose.** It sits BELOW the ui-kit (whose
close/chevron/check icons it will draw), so it cannot import the theme engine,
the ui-kit or live-state, which sit above it; an import either way would be a
cycle. So the pieces around it are wired in, not imported:

- **Which scope an icon is in** — `IconScopeProvider`, rendered by every
  `<Theme>` boundary (`primitives/css/theme-boundary`) with its scope token. It
  is React context, so it crosses portals like the theme does. (A sub-theme's
  popups keep the sub-theme's icon style — the region-only forward is a DOM
  attribute concern the icon scope does not mirror.)
- **What each scope says** — `usePublishIconStyle(scope, style)`, called by the
  token group's `IconThemeBridge` (a `Core.Root`) for the root (`:root`), each
  app with its own theme document, each fixed theme and each sub-theme that
  names the group. A scope with no entry uses the root's, as its CSS inherits
  `:root`; before anything is published the default applies. One publisher per
  scope — a second throws.
- **Sprites** — the `sprites` sub-plugin fills the sprite store
  (`provideSprite`) and mounts `IconSpriteSheet`, an inline hidden container of
  one `<svg>` per sprite, so `<use href="#id">` resolves in-document (portals
  and Fullscreen subtrees included).

Until the wanted style's sprite has loaded, `<Icon>` draws the **default
style's** symbol: the same glyph in the global style, in the same box — the
default sprites are resident from first paint.

## Navigation icons (`navIcons`)

A control that opens something wears the icon of WHERE it sends you, from
`navIcons` (`core/nav-icons.ts`) — never a glyph picked per call site:

| Key | Glyph | Destination |
|---|---|---|
| `navIcons.newTab` | `open-in-new` | Elsewhere, leaving this view: a new browser/app tab, an external site, the system browser, a host app. |
| `navIcons.sidePane` | `right-panel-open` | Beside what you are reading: a pane pushed to the right. |
| `navIcons.expand` | `open-in-full` | Takes over the surface: the pane promoted to root, or opened in its home app ("Open in Pages", "Open in Debug"). |

The three glyphs are reserved: `icons/reserved-nav-icon` rejects `symbol("…")`
of any of them outside `nav-icons.ts`. `fullscreen` is the window-level idea
(solo mode, browser fullscreen, presenting, a full-screen viewer), not a
destination.

## Sprites (`plugins/sprites`)

- **Server** builds each sprite from `@iconify-json/material-symbols` (400) or
  `@iconify-json/material-symbols-light` (300) — all 12 sprites in one pass
  over both sets (a fallback may cross weights), memoized; the sets are parsed
  once per process and dropped — plus a `brands` sprite from `@iconify-json/simple-icons`.
- **Resident**: `icons.sprites` (a `liveValue`, `preload: "boot-and-keep"`)
  carries the default style's two sprites and the brands, with the
  `manifestHash`. The boot snapshot hydrates it, so the sheet is in the first
  commit.
- **On demand**: a style some scope wants that is not resident is fetched from
  `GET /api/icons/sprite/:hash/:key` (the typed `spriteEndpoint`) — immutable
  for its URL; a hash that is not the server's current one is refused (409),
  never answered with bytes the URL does not name. A failed fetch is
  thrown into the host's error boundary.

## Lucide family

A theme scope whose `iconFamily` is `lucide` (`IconStyle.family`) draws every
`symbol("…")` as its Lucide counterpart. Names stay Material: code never writes
a Lucide name, so the shared chrome (ui-kit close buttons, the sidebar toggle,
the path bar, a search field) follows the scope it is drawn in.

- **The map** — `core/lucide-map.ts`, `LUCIDE_MAP`: every manifest symbol →
  its Lucide name (a `LucideName`, so a typo is a tsc error) or
  `MATERIAL_ONLY`. `icons:lucide-coverage` FAILS while any `symbol("…")` in the
  repo has no entry, so adding a symbol means deciding what it is in Lucide.
  `lucideNameOf(name)` is the one reader.
- **The sprite** — one sprite key, `lucide` (`LUCIDE_SPRITE`; Lucide has no
  shape, fill or weight, and `active` draws the same), holding
  `<symbol id="lucide-<material name>">` for every mapped manifest symbol.
  Built from `@iconify-json/lucide` (embedded like the Material sets) and
  **tuned at build** (`plugins/sprites/server/internal/lucide.ts`): the glyph is
  scaled to 7/8 of its box about the centre
  (`translate(1.5 1.5) scale(0.875)` in the 24-unit box) and every stroke is
  `stroke-width="1.2"` with `vector-effect="non-scaling-stroke"` — a ~1.2px
  line at any icon size. `LUCIDE_TUNING_VERSION` and the map are folded into
  the sprite hash. Never resident: the first icon in a Lucide scope with a
  mapped name calls `wantSprite("lucide")`.
- **Fallbacks** — while the sprite loads, and always for a `MATERIAL_ONLY`
  (or not-yet-mapped) symbol, `<Icon>` draws the Material symbol in the
  scope's Material style (`styleKeyOf` still names one: the Material axes keep
  applying in a Lucide scope). Saved (runtime) symbols are user-picked
  Material names and stay Material in every family.

## Seti file-type glyphs

`seti("…")` names a glyph of the Seti file-icon set (jesseweed/seti-ui, MIT —
the icons VS Code's Seti theme draws). Use it through
`primitives/file-type` (`fileTypeOf` / `<FileTypeIcon>`), which owns which
glyph a file gets and its colour; a direct `seti()` elsewhere is rare.

- **Vendored, pinned.** `scripts/vendor-seti.ts` fetches the commit pinned in
  `shared/seti.ts` (`SETI_SOURCE`), refuses if the license is no longer MIT,
  reduces every `icons/*.svg` to ONE colour (`normalizeSetiSvg`: every paint
  `currentColor`, gradients and `<style>` dropped, ids namespaced; an unknown
  element or attribute throws), **crops it to what it paints** — the smallest
  square around the painted bounding box (`shared/seti-bbox.ts`: geometry
  flattened through every transform, curves and arcs sampled, strokes grown by
  half their width, unpainted shapes ignored), centred, with a 1/12 margin a
  side (`SETI_CROP_MARGIN`, the 2-in-24 keyline Material and Lucide draw
  inside) — so every glyph fills its icon box as much as the symbol beside it
  does, instead of sitting in Seti's wide, uneven margins; and writes
  `server/internal/seti/seti.json` (Iconify JSON), the upstream
  `LICENSE.txt` beside it, and `core/seti-names.generated.ts` (`SetiName`).
  To upgrade: bump the commit, rerun; `icons:seti-in-sync` fails until you do.
- **One style.** Like a brand, a Seti glyph ignores the theme's shape and
  fill axes and `active`; it is drawn in `currentColor`, so the caller tints it.
  Its sprite id is `seti-<name>`.
- **Manifest-scanned** like `symbol` / `brand`: the `seti` sprite holds exactly
  the names some code writes (in practice, the file-type table).
- **Never resident.** The `seti` sprite is not in `icons.sprites` (the boot
  snapshot). The first `<Icon icon={seti(…)}>` to mount calls `wantSprite("seti")`
  (`web/internal/sprite-store.ts`); the sprite host fetches every wanted sprite
  from `GET /api/icons/sprite/:hash/seti` (the same immutable, hash-checked
  route as a non-default style). Until it lands a Seti icon is an empty box at
  its final size. So a surface that never shows a file pays nothing.

## Runtime symbols (saved icons)

An icon a USER picked and something stored (an agent avatar, a callout
icon, a configured category avatar) is a Material Symbols name and nothing else —
`SavedSymbolName`, minted only by `SavedSymbolNameSchema` (`plugins/saved-names`,
a membership parse against the installed sets, used by every store: request
bodies, DB columns, config, block data). Its name is not in the build's
manifest, so the sprites do not carry it:

```ts
import { runtimeSymbol } from "@plugins/ui/plugins/icons/core";
<Icon icon={runtimeSymbol(agent.icon)} />   // { kind: "runtime-symbol", name }
```

- `runtimeSymbol` is its own constructor (not `symbol`), outside
  `icons/literal-icon-name` by construction.
- `<Icon>` asks the **runtime symbol store** (`web/internal/runtime-symbol-store.ts`)
  for (style key, name). Chunks of `<symbol id="msr-<styleKey>-<name>">` are
  appended to the sheet (their own id prefix, so a name also in the manifest
  never yields two elements with one id).
- **Resident at boot:** `icons.saved-sprites` (sprites plugin, `boot-and-keep`)
  carries the default style's drawing of every name a saved-icon source
  reports. A source is `defineSavedIconSource({ id, tables, names, watch? })` (sprites
  server barrel; the sprites plugin knows no source): DB-backed ones read
  through `db` and list their `tables` (the value's declared reads) so changes recompute the value (agents, callout
  blocks, preprompt launch snapshots), config ones pass `tables: []` and `watch`
  (conversation-category, preprompts).
- **On demand:** a name/style no chunk holds is a want; the sprites plugin's
  loader batches every want of a frame into one
  `GET /api/icons/symbols/:hash/:key?names=a,b` per style (sorted, so
  content-addressed and immutable; unknown name 404, stale hash 409) and a
  failed batch throws into its error boundary.
- **Fallback:** while the wanted style's symbol loads `<Icon>` draws the default
  style's symbol for the same name, like a code icon — so a theme switch never
  blanks a saved icon. Only a name with no drawing in any style yet renders an
  empty box at its final size (a loading state).
- **Theme changes are live:** only the name is stored and the style key is
  resolved from the scope at render, so saved icons restyle with their scope.

A page icon is NOT a saved symbol: it is an emoji (`plugins/emoji`,
`EmojiSchema`), drawn as a glyph by `<EmojiGlyph>` in an icon-sized box.

## Deviations from the plan

- The plan had `<Icon>` resolve the scope with theme-engine's
  `useThemeScopeId()` + `useResolvedTheme()`. `useThemeScopeId` is the
  customizer's editing scope (undefined everywhere else), and any theme-engine
  import from here closes a cycle once the ui-kit draws `<Icon>`. Hence the
  leaf + publish/scope-context split above.
- The sprite route and resident value live in the `sprites` sub-plugin, not in
  this plugin's `server/`, for the same reason: `core/` stays import-free so
  every runtime (and every `core/` file of every plugin) can name an icon.
- The manifest is not in `core/` (see "The rules"), and the weight token is
  `iconStroke`, not `iconWeight` (a `-weight` var is a type metric).
- On-demand sprites use the path `/:hash/:key`, not `?v=`, so the typed
  endpoint (`spriteEndpoint`, a blob) carries the version as a param.
- Lucide (plan `research/2026-10-06-apps-files-match-prototype.md` §1): the
  plan had `styleKeyOf` return `lucide` for a Lucide style. It still returns a
  Material `StyleKey` — the Material drawing a Lucide scope falls back to (and
  the key runtime symbols use) — and `<Icon>` picks the `lucide` sprite itself
  for a mapped name, so `StyleKey` stays the closed Material set and only
  `SpriteKey` widens. An unmapped name falls back to the scope's Material style
  rather than to a Material drawing baked into the Lucide sprite.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Draws icons: <Icon icon={symbol(…)} active?/> renders an IconRef from the page's inline SVG sprites in its theme scope's icon style. A leaf below the ui-kit — it knows no theme: the icons token group publishes each scope's style (usePublishIconStyle), <Theme> boundaries say which scope an icon is in (IconScopeProvider), and the sprites plugin fills and mounts the sheet. Reads glyphs out of the installed Iconify JSON: resolveIcon (a name in a set, aliases followed), resolveSymbol (the icon drawing a symbol in a style, after the nearest-style fallback) and symbolBody (one Material Symbols glyph in a style, for a consumer with no sprite sheet — the release CLI's app icon); SETI_SET / readSetiSet expose the vendored Seti file-type set (jesseweed/seti-ui, MIT, one colour).
- Web:
  - Slots: `Icons.Root`
  - Slot contributors:
    - `Icons.Root` ← `ui.icons.sprites`
    - `Icons.Root` ← `ui.tokens.icons`
  - Contributes: `Core.Root`
  - Exports (types):
    - `IconMarkup`
    - `IconMarkupReader`
    - `IconProps`
    - `RuntimeSymbolEntry`
  - Exports (values):
    - `hasRuntimeSymbol`
    - `hasSprite`
    - `Icon`
    - `Icons`
    - `IconScopeProvider`
    - `IconSpriteSheet`
    - `installRuntimeSymbolLoader`
    - `provideRuntimeSymbols`
    - `provideSprite`
    - `useIconMarkup`
    - `useIconStyle`
    - `usePublishIconStyle`
    - `useWantedSprites`
    - `useWantedStyleKeys`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --spacing`
  - Imported by: 305 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×65
    - `conversations` ×57
    - `primitives` ×41
    - `page` ×40
    - `fields` ×33
    - `debug` ×14
    - `ui` ×8
    - `apps-core` ×6
    - `tasks` ×6
    - `active-data` ×4
    - `plugin-meta` ×4
    - `reorder` ×4
    - `review` ×4
    - `build` ×3
    - `auth` ×2
    - `backup` ×2
    - `config_v2` ×2
    - `shell` ×2
    - `framework/tooling/codegen`
    - `fullscreen`
    - `improve`
    - `infra/events-test`
    - `layouts/miller`
    - `map`
    - `reports/launch-fix`
    - `screenshot`
- Exemptions:
  - Exempts itself from: `icons/reserved-nav-icon` — `core/nav-icons.ts` (sanctioned)
  - Exempted by: `ui/icons` (0 debt)
- Server:
  - Exports (types):
    - `IconBody`
    - `SymbolSets`
  - Exports (values):
    - `readSetiSet`
    - `resolveIcon`
    - `resolveSymbol`
    - `SETI_SET`
    - `symbolBody`
- Core:
  - Exports (types):
    - `BrandName`
    - `BrandRef`
    - `IconFamily`
    - `IconFill`
    - `IconRef`
    - `IconShape`
    - `IconStyle`
    - `IconWeight`
    - `LucideName`
    - `RuntimeSymbolRef`
    - `SavedSymbolName`
    - `SetiName`
    - `SetiRef`
    - `SpriteKey`
    - `StyleKey`
    - `SymbolName`
    - `SymbolRef`
  - Exports (values):
    - `ALL_STYLE_KEYS`
    - `brand`
    - `brandId`
    - `BRANDS_SPRITE`
    - `coveredStyles`
    - `DEFAULT_ICON_STYLE`
    - `DEFAULT_STYLE_KEYS`
    - `ICON_FAMILIES`
    - `ICON_FILLS`
    - `ICON_SHAPES`
    - `ICON_WEIGHTS`
    - `iconifyName`
    - `isIconRefModule`
    - `isSpriteKey`
    - `isStyleKey`
    - `LUCIDE_MAP`
    - `LUCIDE_SPRITE`
    - `lucideId`
    - `lucideNameOf`
    - `navIcons`
    - `parseStyleKey`
    - `resolveSymbolStyle`
    - `runtimeSymbol`
    - `runtimeSymbolId`
    - `seti`
    - `SETI_SPRITE`
    - `setiId`
    - `styleKeyOf`
    - `symbol`
    - `symbolId`
- Shared:
  - Exports (types): `SymbolNameList`
  - Exports (values):
    - `brandNames`
    - `buildSetiSet`
    - `ICON_SET_PACKAGES`
    - `installedSetVersions`
    - `lucideNames`
    - `normalizeSetiSvg`
    - `readIconSet`
    - `readInputsHash`
    - `readListInputsHash`
    - `readSetiIdentity`
    - `renderSetiNames`
    - `renderSymbolNameList`
    - `renderSymbolNames`
    - `SETI_JSON_REL_PATH`
    - `SETI_LICENSE_REL_PATH`
    - `SETI_NAMES_REL_PATH`
    - `SETI_NORMALIZER_VERSION`
    - `SETI_SOURCE`
    - `setiIdentity`
    - `SYMBOL_NAME_LIST_REL_PATH`
    - `SYMBOL_NAMES_REL_PATH`
    - `symbolBaseNames`
    - `symbolNamesInputsHash`
- Sub-plugins:
  - **`emoji`** — The <EmojiPicker>: a searchable, categorized emoji grid over frimousse whose emojibase data is served same-origin by the asset mirror; onSelect hands back a parsed Emoji. Plus <EmojiGlyph>, which…
  - **`saved-names`** — The membership-checked SavedSymbolName: a user-picked Material Symbols name, parsed against the installed sets before anything stores it.
  - **`sprites`** — Mounts the page's icon sprites inline: the resident default-style sprites from the boot snapshot (present at first paint) plus, on demand, the sprite of every other style a theme scope picks. Builds…

<!-- AUTOGENERATED:END -->
