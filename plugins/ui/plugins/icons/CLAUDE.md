# icons

Every icon in code is a **Material Symbols** glyph, named as data and drawn in
the style its theme scope picks — or, in a scope whose icon family is another
one (Lucide, an app's own), as that family's drawing of it (see "Icon
families"). Plan and rationale:
[`research/2026-09-27-global-material-symbols-icons.md`](../../../../research/2026-09-27-global-material-symbols-icons.md),
families: [`research/2026-10-20-ui-app-icon-families.md`](../../../../research/2026-10-20-ui-app-icon-families.md).

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
  `core/symbol-names.generated.ts` by `./equin build` / `regen-generated`
  (`plugins/icon-sets` derives them from the installed `@iconify-json/*`
  sets), so an icon-set upgrade regenerates them (`icons:symbol-names-in-sync`).
- **Literal names only.** `symbol("…")` / `brand("…")` / `seti("…")` take a string literal,
  imported under their own name and only ever called
  (lint `icons/literal-icon-name`). The build scans those literals into the
  icon manifest (`codegen/core/icon-manifest-gen.ts`, a pre-barrel manifest;
  `icons:manifest-in-sync`), and the sprites ship exactly the manifest — a
  name the scan cannot see would draw an empty box. The manifest sits beside
  its one reader, `plugins/sprites/machine/internal/icon-manifest.generated.ts`,
  not in `core/`: the CLI loads the core barrel (through this plugin's checks)
  in the process that regenerates the manifest, which would freeze it.
- `<Icon>` is an `<svg viewBox="0 0 24 24" width="1em" height="1em">` holding
  `<use href="#<id>">`, so `size-*` classes and `[&_svg]:…` rules size it as
  before. Hidden from assistive tech unless it has `title` / `aria-label` /
  `aria-labelledby`; every other svg prop passes through.

## How a style is chosen

The style axes are the `icons` token group
(`plugins/ui/plugins/tokens/plugins/icons`): `iconFamily` (`material` or a
contributed family's id — see "Icon families"), `iconShape` (default | rounded |
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
- **On demand**: a style some scope wants that is not resident is read as the
  `icons.sprite` live value (`iconSprite`, params `{ hash, key }` — `hash` the
  resident value's `manifestHash` — `load: "on-demand"`, external `immutable`:
  content-addressed by the manifest). An unknown key is refused
  (`unknown-key`), and so is a hash that is not the serving process's
  (`stale-manifest`: the tab predates a restart that changed the manifest).
  A refusal is thrown into the host's error boundary; a transient failure is
  reported and leaves that key's icons on their fallback.

## Icon families

A family is a drawing a scope's `iconFamily` can pick, contributed to
`Icons.Family` (web, `{ family: IconFamily }`) — an open set; `material` is the
built-in base and no contribution. `IconFamilyHost` (an `Icons.Root`
companion) publishes the contributions to the page-global family store in a
layout effect (no fallback flash) and renders app-drawn families' glyphs
hidden in the page as `<symbol id="fam-<family>-<glyph>">`.

- **Two kinds** (`core/icon-family.ts`): a `SpriteIconFamily` draws from a
  server-built sprite fetched on first use (`idOf(name)` → its sprite id —
  Lucide, `LUCIDE_FAMILY`, contributed by this plugin); an `InlineIconFamily`
  (`defineIconFamily`, from an app's `core/`) ships its glyph bodies as data
  in the app's bundle. A body holds shape elements only (checked at define
  time); its paint (`stroke` at the family's `stroke` width, round caps and
  joins, or `fill`) is the sheet's one `<g>` around it, so callers need no CSS.
- **A symbol in family F** draws from the first family of the chain F →
  `F.fallback` → … that maps it (`familyGlyphOf`: an inline family's
  `symbols`, a sprite family's `idOf`); a sprite family whose sprite has not
  loaded is wanted and the walk goes on. Material ends every chain, in the
  scope's Material style. A family not (yet) contributed ends the chain early —
  its plugin may load in a later tier, so its scopes draw Material meanwhile. A
  fallback loop throws.
- **Active forms**: a family has no fill axis, so `<Icon active>` in a scope
  whose `iconActiveFill` is `filled` draws the glyph's ACTIVE FORM — see
  "Active forms (line families)" below. An inline glyph's is in the sheet
  as `famact-<family>-<glyph>`, beside `fam-…`; a sprite family's comes from
  its `activeSprite` (`idOf(name, active)`).
- **Coverage is required** (`IconFamilyCoverage`, a discriminated union, so tsc
  makes every family state it): `coverage: "fallback"` (with an optional
  `fallback` family — the chain above) or `coverage: "strict"` (no `fallback`
  can be spelled). In a scope whose chain ends at a STRICT family, a `symbol`
  it does not map draws the family's **gap glyph** — a dashed rounded square,
  one `<symbol id="famgap-<family>">` in its sheet — never Lucide or Material,
  and `<Icon>` (and `useIconMarkup`) report it once per (family, name) per page
  into `iconFamilyGapReportSink`; `reports/icon-family-gap` drains it into an
  `icon-family-gap` report. Only `symbol` refs are subject: `brand`, `seti`,
  `runtime-symbol` (user-picked icons) and `custom` keep their own drawing.
  Sprite families are always `fallback` (the gap lives in an inline sheet).
  Staged: a family ships `fallback`, and flips to `strict` once Debug → Icons
  shows it falls back for nothing.
- **`resolveIconSource(name, familyId)`** (web) — where a family's drawing of a
  name comes from, by MAPPING (not by what has loaded): `{ kind: "own", glyph }`,
  `{ kind: "fallback", family }` (`material` at the chain's end) or
  `{ kind: "gap", family }`. Built on the same `familyChain` + `familyGlyphOf`
  `<Icon>` walks, so a coverage page cannot disagree with an app. For a
  `material` id it is `own`. Families, their `coverage` and an inline family's
  `symbols` keys come from `useIconFamilies()`.
- **`IconFamilyPreview`** (web) — `<IconFamilyPreview family="…">` draws the
  icons below as that family draws them (its chain, every other axis the
  enclosing scope's): for an INSPECTION surface showing one name in several
  families side by side (Debug → Icons). A gap drawn under it is never
  reported. An app picks its family through its theme, never this.
- **`useScopeIconStyles(scopes)`** (web) — the icon style each scope token draws
  with (its published style, else the root's, else the default), for a surface
  listing many scopes at once (every app's family on Debug → Icons).
- **App-only glyphs**: `family.icon("piano-roll")` mints a `CustomRef`
  (`{ kind: "custom", family, name }`, the name checked by tsc against the
  family's glyphs). It draws from its family in every scope — one style, like a
  brand — and is an empty box at its final size until the family is
  contributed. Not manifest-scanned: the whole family ships with its plugin.
- `readIconTokens` checks a family id's spelling only; the customizer's Family
  picker lists Material plus every contributed family.

Example: `apps/sonata/primitives/icons` (`sonataIcons`, fallback `lucide`).

## Icon motion (animated glyphs)

A family glyph may MOVE: a part of its body carries `data-motion="<kind>"`,
optionally `data-motion-delay="<ms>"` (a stagger) and
`data-motion-origin="<x> <y>"` (its transform origin in the 24-unit grid;
otherwise the part's own box centre).

- **A closed vocabulary** — `ICON_MOTIONS` (`core/icon-motion.ts`): nudge-up /
  -down / -left / -right, turn, pop, draw, blink, blink-y, bob, type, scan,
  tilt, scribble, shake, slide, splay-l / -r, link-a / -b, open-l / -r,
  squeeze, grow, hop, hop-small, drift, flip, rewind, spin, bubble, launch, flicker,
  light, twinkle, spark — the agent-icons prototype's
  (`proto-1789643584-ldt6`), timings included. A new kind is an entry there
  plus its keyframes and rule in `web/internal/icon-motion.css`.
- **Checked at definition**: `defineIconFamily` throws on an unknown kind, a
  malformed delay / origin, any other `data-motion-*` attribute, a delay or
  origin without a kind, a `style` beside them, and a `draw` on a `<g>`. It
  writes the DRAWN body: delay → inline `--icon-motion-delay`, origin → inline
  `transform-box:view-box; transform-origin`, and `pathLength="1"` on a `draw`
  part. `IconGlyph.animated` is derived (any `data-motion`) — never declared.
- **Drawn inline**: `<Icon>` draws an animated glyph — a mapped `symbol`'s or
  an app-only `CustomRef`'s alike — as a `<g>` holding
  `familyGlyphBody` (the same paint + body the sheet's `<symbol>` holds), not
  `<use>` — CSS cannot reach into a `<use>` shadow tree. Still glyphs keep
  `<use>`.
- **Played only in a motion region**: `icon-motion.css` (imported by
  `IconFamilyHost`, so it ships wherever icons do) animates a part only under
  `[data-icon-motion-region] :is(a, button, [role=button|option|treeitem|menuitem|tab]):hover`.
  A CSS animation starts when its selector starts matching, so it plays once
  per hover entry and settles at rest; no JS. `prefers-reduced-motion: reduce`
  turns it off. A region is `{...IconMotionRegion}` (attribute props, web
  barrel) on an element. Today exactly one caller: the app-shell sidebar
  (`primitives/app-shell` `AppShellLayout`'s sidebar content). The toolbar,
  menus, popovers (portalled out of the region's DOM) and transcript are never
  in a region, so the same glyphs stay still there. A `type` part is invisible
  at rest, in or out of a region.

## Active forms (line families)

Material's `active` is a fill axis (`iconActiveFill`); a line family has none,
so its active drawing is DERIVED from the line drawing —
`deriveActiveForm(body)` (`core/active-form.ts`, pure TS, every runtime):

- every **outer closed shape** is filled (a circle, rect, polygon, ellipse, or
  a path whose subpaths are closed — an open straight stroke beside them, like
  a pin's needle, is allowed: filling it adds nothing);
- what lies **inside** a filled shape — an open stroke (a check, text lines, a
  clock's hands), a closed shape nested in it (an eye's pupil, a gear's hub),
  a filled dot (a bot's eyes) — is **cut out** of the fill at its own stroke;
  outside every fill it still draws as a line.

Two `<mask>`s do the cut (SVG has no boolean geometry), so a form carries mask
ids: written with `ACTIVE_ID_TOKEN` and placed (`placeActiveIds`) by whoever
puts it in the page — the sheet under the symbol id, an inline (animated)
`<Icon>` under its own `useId`, so no two copies share an id. A mask under
`display: none` is not rendered: the sheets are **zero-size, never `hidden`**
(`web/internal/sheet-style.ts`). Each part keeps its ancestors (`<g>` with a
transform, a paint, a motion) copied around it, so a moving part's fill and
its cut-out move together. A glyph with no outer closed shape (a chevron, a
list) has no active form and draws the same; so does a `paint: "fill"` glyph.

- **Inline families** derive it in `defineIconFamily`; a glyph's own `active`
  body wins — write one only where the derivation misses (a shape left open).
- **Lucide** derives it at sprite build into its own sprite, `lucide-active`
  (`LUCIDE_ACTIVE_SPRITE`, `lucide-active-<material name>`; the drawing at
  rest where nothing fills), fetched the first time an active Lucide icon
  mounts — the rest drawing stands in until then.
- `ACTIVE_FORM_VERSION` is folded into the sprite hash: bump it with any
  change to the derivation's output.
- A scope whose `iconActiveFill` is `outline` draws every family's active
  icons as at rest, as it does Material's.

## Lucide family

A theme scope whose `iconFamily` is `lucide` (`IconStyle.family`) draws every
`symbol("…")` as its Lucide counterpart. Names stay Material: code never writes
a Lucide name, so the shared chrome (ui-kit close buttons, the sidebar toggle,
the path bar, a search field) follows the scope it is drawn in.

- **The family** — `LUCIDE_FAMILY` (`core/lucide-map.ts`), a sprite family
  this plugin contributes to `Icons.Family` like any other.
- **The map** — `core/lucide-map.ts`, `LUCIDE_MAP`: every manifest symbol →
  its Lucide name (a `LucideName`, so a typo is a tsc error) or
  `MATERIAL_ONLY`. `icons:lucide-coverage` FAILS while any `symbol("…")` in the
  repo has no entry, so adding a symbol means deciding what it is in Lucide.
  `lucideNameOf(name)` is the one reader.
- **The sprite** — one sprite key, `lucide` (`LUCIDE_SPRITE`; Lucide has no
  shape, fill or weight; its active drawings are the `lucide-active` sprite,
  see "Active forms"), holding
  `<symbol id="lucide-<material name>">` for every mapped manifest symbol.
  Built from `@iconify-json/lucide` (embedded like the Material sets) and
  **tuned at build** (`plugins/sprites/machine/internal/lucide.ts`): the glyph is
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
  square around the painted bounding box (`core/glyph-geometry.ts`: geometry
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
  (`web/internal/sprite-store.ts`); the sprite host reads every wanted sprite
  as `icons.sprite` `{ hash, key: "seti" }` (the same on-demand value as a
  non-default style). Until it lands a Seti icon is an empty box at
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
  reports. A source is `defineSavedIconSource({ id, tables, names, watch? })`
  (`plugins/saved-sources` server barrel — portable, so a browser-hosted server
  half can register one; the sprites plugin knows no source): DB-backed ones read
  through `db` and list their `tables` (the value's declared reads) so changes recompute the value (agents, callout
  blocks, preprompt launch snapshots), config ones pass `tables: []` and `watch`
  (conversation-category, preprompts).
- **On demand:** a name/style no chunk holds is a want; the sprites plugin's
  loader batches every want of a frame into one `icons.runtime-symbols` live
  value tuple `{ hash, key, names }` per style (`names` sorted, at most 200, so
  content-addressed and `immutable`; refused `unknown-key`, `stale-symbols`,
  `invalid-names`, `unknown-name`), read with `useLive` until it lands; a
  refused batch throws into its error boundary.
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
- The sprite values (resident and on-demand) live in the `sprites` sub-plugin, not in
  this plugin's `server/`, for the same reason: `core/` stays import-free so
  every runtime (and every `core/` file of every plugin) can name an icon.
- The manifest is not in `core/` (see "The rules"), and the weight token is
  `iconStroke`, not `iconWeight` (a `-weight` var is a type metric).
- Lucide (plan `research/2026-10-06-apps-files-match-prototype.md` §1): the
  plan had `styleKeyOf` return `lucide` for a Lucide style. It still returns a
  Material `StyleKey` — the Material drawing a Lucide scope falls back to (and
  the key runtime symbols use) — and `<Icon>` picks the `lucide` sprite itself
  for a mapped name, so `StyleKey` stays the closed Material set and only
  `SpriteKey` widens. An unmapped name falls back to the scope's Material style
  rather than to a Material drawing baked into the Lucide sprite.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Draws icons: <Icon icon={symbol(…)} active?/> renders an IconRef from the page's inline SVG sprites in its theme scope's icon style. A leaf below the ui-kit — it knows no theme: the icons token group publishes each scope's style (usePublishIconStyle), <Theme> boundaries say which scope an icon is in (IconScopeProvider), and the sprites plugin fills and mounts the sheet. Icon families beyond Material are contributed to Icons.Family (Lucide is this plugin's own; an app draws its own with defineIconFamily), published to <Icon> by IconFamilyHost. A family states its coverage: fallback (an unmapped symbol draws the next family of its chain, Material last) or strict (its gap glyph, reported through iconFamilyGapReportSink); resolveIconSource answers which, by the same chain. Animated family glyphs (data-motion parts, a closed ICON_MOTIONS vocabulary) are drawn inline and play once on hover inside an IconMotionRegion. Reads glyphs out of the installed Iconify JSON: resolveIcon (a name in a set, aliases followed), resolveSymbol (the icon drawing a symbol in a style, after the nearest-style fallback) and symbolBody (one Material Symbols glyph in a style, for a consumer with no sprite sheet — the release CLI's app icon); SETI_SET / readSetiSet expose the vendored Seti file-type set (jesseweed/seti-ui, MIT, one colour).
- Web:
  - Slots:
    - `Icons.Root`
    - `Icons.Family`
  - Slot contributors:
    - `Icons.Root` ← `ui.icons`
    - `Icons.Root` ← `ui.icons.sprites`
    - `Icons.Root` ← `ui.tokens.icons`
    - `Icons.Family` ← `apps.agent-manager.icons`
    - `Icons.Family` ← `apps.prototypes.icons`
    - `Icons.Family` ← `apps.sonata.primitives.icons`
    - `Icons.Family` ← `ui.icons`
  - Contributes:
    - `Core.Root`
    - `Icons.Root` → `IconFamilyHost`
    - `Icons.Family` "Lucide"
  - Exports (types):
    - `IconFamilyContribution`
    - `IconFamilyGap`
    - `IconMarkup`
    - `IconMarkupReader`
    - `IconProps`
    - `IconSource`
    - `RuntimeSymbolEntry`
  - Exports (values):
    - `hasRuntimeSymbol`
    - `Icon`
    - `iconFamilyGapReportSink`
    - `IconFamilyPreview`
    - `IconMotionRegion`
    - `Icons`
    - `IconScopeProvider`
    - `IconSpriteSheet`
    - `installRuntimeSymbolLoader`
    - `provideRuntimeSymbols`
    - `provideSprite`
    - `resolveIconSource`
    - `useIconFamilies`
    - `useIconMarkup`
    - `useIconStyle`
    - `usePublishIconStyle`
    - `useScopeIconStyles`
    - `useWantedSprites`
    - `useWantedStyleKeys`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --spacing`
  - Imported by: 353 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×91
    - `conversations` ×56
    - `primitives` ×42
    - `fields` ×41
    - `page` ×41
    - `debug` ×15
    - `tasks` ×8
    - `ui` ×8
    - `active-data` ×5
    - `audience` ×4
    - `plugin-meta` ×4
    - `review` ×4
    - `shell` ×4
    - `apps-core` ×3
    - `build` ×3
    - `config_v2` ×3
    - `hints` ×3
    - `reorder` ×3
    - `backup` ×2
    - `infra` ×2
    - `reports` ×2
    - `auth`
    - `framework/tooling/codegen`
    - `fullscreen`
    - `layouts/miller`
    - `map`
    - `menu-bar`
    - `screenshot`
    - `tag-tree/picker`
    - `wish`
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
    - `CustomRef`
    - `IconFamily`
    - `IconFamilyCoverage`
    - `IconFamilyId`
    - `IconFill`
    - `IconGlyph`
    - `IconGlyphSource`
    - `IconMotion`
    - `IconRef`
    - `IconShape`
    - `IconStyle`
    - `IconWeight`
    - `InlineIconFamily`
    - `LucideName`
    - `RuntimeSymbolRef`
    - `SavedSymbolName`
    - `SetiName`
    - `SetiRef`
    - `SpriteIconFamily`
    - `SpriteKey`
    - `StyleKey`
    - `SymbolName`
    - `SymbolRef`
  - Exports (values):
    - `ACTIVE_FORM_VERSION`
    - `ACTIVE_ID_TOKEN`
    - `ALL_STYLE_KEYS`
    - `brand`
    - `brandId`
    - `BRANDS_SPRITE`
    - `coveredStyles`
    - `DEFAULT_ICON_STYLE`
    - `DEFAULT_STYLE_KEYS`
    - `defineIconFamily`
    - `deriveActiveForm`
    - `familyGapId`
    - `familyGlyphBody`
    - `familyGlyphId`
    - `familyGlyphMarkup`
    - `familyGlyphOf`
    - `ICON_FILLS`
    - `ICON_MOTIONS`
    - `ICON_SHAPES`
    - `ICON_WEIGHTS`
    - `iconifyName`
    - `isIconFamilyId`
    - `isIconMotion`
    - `isIconRefModule`
    - `isSpriteKey`
    - `isStyleKey`
    - `LUCIDE_ACTIVE_SPRITE`
    - `LUCIDE_FAMILY`
    - `LUCIDE_MAP`
    - `LUCIDE_SPRITE`
    - `lucideActiveId`
    - `lucideId`
    - `lucideNameOf`
    - `MATERIAL_FAMILY`
    - `navIcons`
    - `paintedBox`
    - `parseStyleKey`
    - `placeActiveIds`
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
  - Exports (values):
    - `buildSetiSet`
    - `normalizeSetiSvg`
    - `readSetiIdentity`
    - `renderSetiNames`
    - `SETI_JSON_REL_PATH`
    - `SETI_LICENSE_REL_PATH`
    - `SETI_NAMES_REL_PATH`
    - `SETI_NORMALIZER_VERSION`
    - `SETI_SOURCE`
    - `setiIdentity`
- Sub-plugins:
  - **`emoji`** — The <EmojiPicker>: a searchable, categorized emoji grid over frimousse whose emojibase data is served same-origin by the asset mirror; onSelect hands back a parsed Emoji. Plus <EmojiGlyph>, which…
  - **`icon-sets`** — The installed @iconify-json sets, host-side: read one (readIconSet), their versions, and the SymbolName / BrandName / LucideName unions and the saved-names runtime list derived from them — rendered…
  - **`saved-names`** — The membership-checked SavedSymbolName: a user-picked Material Symbols name, parsed against the installed sets before anything stores it.
  - **`saved-sources`** — The saved-icon source registry: defineSavedIconSource registers a place that stores user-picked icons (its tables, its names, a watch for a non-DB store), and savedIconSources lists them for the…
  - **`sprites`** — Mounts the page's icon sprites inline: the resident default-style sprites from the boot snapshot (present at first paint) plus, on demand, the sprite of every other style a theme scope picks.

<!-- AUTOGENERATED:END -->
