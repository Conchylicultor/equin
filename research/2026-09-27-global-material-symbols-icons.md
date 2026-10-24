# Material Symbols icons, themed per app (SVG sprites)

## Context

The app draws icons with `react-icons/md`: Google's classic **Material Icons**,
filled by default. Google has frozen that set; every new icon and every style
axis now ships only as **Material Symbols**. The Mist prototype
(`proto-1789643584-ldt6`) already uses Symbols Outlined, which is why its icons
look lighter than the app's even though both are "Material".

Goal:

1. Every icon in code comes from Material Symbols.
2. How icons look is a **theme** decision, per app scope like every other token:
   shape (default / rounded / sharp), fill (outline / filled), filled when
   active, weight (regular / light). Global default: **outline, filled when
   active**.
3. An icon in code is **data** (`symbol("forum")`), not a component, so the
   theme, not the call site, picks the variant.

Out of scope (own task): remapping **saved** icons (agents `icon` +
`icon_svg_nodes`, avatar config fields, page icons) and moving the icon
picker onto Symbols. They keep rendering their stored `SvgNode`s unchanged
until then. Done in
[`2026-09-27-global-saved-icons-material-symbols.md`](2026-09-27-global-saved-icons-material-symbols.md).

## Decisions (settled with the user)

- **Icons are data.** Slots take `icon: IconRef`; one `<Icon>` draws it.
- **Rendering = SVG sprites, not the variable font.** The font gives
  continuous weight/grade and pure-CSS theming, but it makes an icon a text
  glyph (font loading, text selection and screen-reader behaviour, softer
  rendering that varies by OS, harfbuzz subsetting of variable axes) and
  leaves two forms of an icon forever, because favicons, app icons and saved
  icons need path geometry. Sprites keep one form (paths from
  `@iconify-json/material-symbols`) everywhere.
- **Style is themed.** A new `icons` token group; `<Icon>` reads the scope's
  resolved values.

### Why not the obvious tools

- **`unplugin-icons` (`~icons/…`) is ruled out.** The web builder has no Vite
  plugin slot: `vite/` contributions feed only Babel
  (`web-core/core/vite-contributions.ts`). vitest has its own plugin list. Bun
  (checks, docgen, `barrel-import`) cannot resolve `~icons/*`, and many `core/`
  files import icons.
- **Importing per-icon npm modules** (`@iconify-icons/material-symbols/forum-outline`)
  would work everywhere, but it freezes the variant at the call site, so
  themes could not change it.
- **An in-repo icon plugin exporting per-icon data is ruled out.** Cross-plugin
  barrels are separate shared artifacts in the import map, so the whole set
  would load at once with no tree-shaking.

## Design

### The API

```ts
// any runtime (pure data — core/, server/, web/ all fine)
import { symbol, brand, type IconRef } from "@plugins/ui/plugins/icons/core";

const forumIcon = symbol("forum");        // IconRef { kind: "symbol", name: "forum" }
const notionIcon = brand("notion");       // IconRef { kind: "brand",  name: "notion" }

Sidebar.Item({ title: "Conversations", icon: forumIcon });   // slots: icon: IconRef
```

```tsx
// web
import { Icon } from "@plugins/ui/plugins/icons/web";

<Icon icon={forumIcon} className="size-4" />
<Icon icon={pinIcon} active={pinned} className="size-4" />   // filled when active (theme)
```

- `symbol(name: SymbolName)`: `SymbolName` is a generated union of the
  **base** Material Symbols names that exist in every style variant.
  Unknown names are a tsc error.
- `brand(name: BrandName)`: Simple Icons (`@iconify-json/simple-icons`), the
  same source as `react-icons/si`. Brands ignore the theme and always use
  their own mark.
- **Lint `icons/literal-icon-name`:** the argument must be a string literal.
  This keeps usage statically collectable (below) and rules out `symbol(x)`.
- `<Icon>` renders `<svg viewBox="0 0 24 24" class=… aria-hidden><use href="#<id>"/></svg>`.
  - The root is still an `<svg>` at 1em, so the 39 `[&_svg]:…` sizing rules and
    `className="size-*"` work as today.
  - `aria-label`, `title` and `style` pass through.

### Themed style: token group `ui/tokens/plugins/icons`

Modeled on `ui/plugins/tokens/plugins/scrollbar` (`core/group.ts` +
customizer section):

| token | values | default |
|---|---|---|
| `iconShape` | `default` \| `rounded` \| `sharp` | `default` |
| `iconFill` | `outline` \| `filled` | `outline` |
| `iconActiveFill` | `filled` \| `outline` | `filled` |
| `iconWeight` | `regular` (Material Symbols, 400) \| `light` (`material-symbols-light`, 300) | `regular` |

`<Icon>` resolves the scope's values with the theme-engine's
`useThemeScopeId()` + `useResolvedTheme()`
(`plugins/ui/plugins/theme-engine/web/index.ts`). That gives a **style key**
(e.g. `default-outline-400`) and, when `active`, the active variant. The
sprite symbol id is `ms-<styleKey>-<name>`; brands use `si-<name>`.

### Only the icons the code uses ship: the manifest

- `./equin build` codegen scans the repo for `symbol("…")` /
  `brand("…")` literals. It writes
  `plugins/ui/plugins/icons/core/icon-manifest.generated.ts` (sorted name
  lists).
- The manifest is committed, like the other `*.generated.ts` registries:
  - an `icons:manifest-in-sync` check guards drift;
  - a `.gitattributes` entry lets the post-merge normalize pass regenerate it
    (see `framework/plugins/cli` "Generated artifacts across a merge").
- `SymbolName` / `BrandName` unions are generated from the Iconify JSON into
  `core/symbol-names.generated.ts`. An in-sync check hashes the package
  version, following the `icon-svg-map-in-sync` precedent in
  `primitives/icon-picker/check`.

### Sprites: server-built, injected inline

- **Server:** the icons plugin serves `GET /api/icons/sprite/:styleKey?v=<manifestHash>`.
  - The body is one `<svg>` of `<symbol id="ms-<styleKey>-<name>">` for every
    manifest name, built from `@iconify-json/material-symbols` (or `-light`)
    and memoized per style key.
  - Brands are one extra `brands` sprite.
  - It is content-addressed, so it's served with immutable caching (precedent:
    `infra/asset-mirror/server/internal/handle-mirror.ts`).
- **Web:** a Core.Root host keeps a hidden inline `<svg>` holding the sprites
  for every style key some scope currently resolves to, plus brands. It uses
  local `#id` references rather than an external `<use href="file#id">`. That
  choice keeps the fetch preloadable and hydrated before first paint, and
  keeps icons working inside Fullscreen API subtrees and portals.
- **Boot:** register the sprites as a **resident** boot-critical resource
  through `infra/boot-snapshot`, so the default styles are present at first
  paint.
  - A style picked later (an app switched to rounded) loads on demand.
  - Until it arrives, `<Icon>` renders the **default style's** symbol. That
    isn't a data stand-in: it's the same glyph in the global style, and the
    box doesn't move.
- **Size budget:** about 250 used icons × ~0.5 KB ≈ 125 KB raw per style,
  much less gzipped. The default theme needs two style keys (outline, and
  filled for active).

### App icons and rasterization

- `apps-core/app-icon`: `mdAppIcon(MdX)` (which calls the component to extract
  its paths) becomes `appIcon(symbol("x"))`. `AppIcon` gains
  `{ kind: "symbol", name }`, rendered with `<Icon>`.
- `app-icon/core/app-icon-to-svg.ts` (the release CLI's favicon/Tauri source)
  resolves `name` → path body from the Iconify JSON under Bun in the global
  default style.
- `app-icon/check`'s `MD_APP_ICON` regex becomes one reading
  `appIcon(symbol("…"))`. Its `iconKey` consistency check stays.

## Migration

### 1. Primitive and plumbing (one commit, no call sites)

- New plugin `plugins/ui/plugins/icons`, with a `CLAUDE.md` holding this
  design:
  - `core`: `symbol`, `brand`, `IconRef`, generated names + manifest;
  - `web`: `<Icon>`, the sprite host, `useIconStyle`;
  - `server`: the sprite route;
  - `check`: in-sync checks.
- It goes under `ui/`, which the plugin index describes as the umbrella for
  pluggable UI components with switchable visual variants. `primitives/` and
  `infra/` must not gain new top-level plugins.
- New token group `plugins/ui/plugins/tokens/plugins/icons` + customizer
  section.
- Dependencies in the root `package.json`: `@iconify-json/material-symbols`,
  `@iconify-json/material-symbols-light`, `@iconify-json/simple-icons`,
  `@iconify/types`. Nothing web-side imports them (sprites are built on the
  server), so `web-artifacts`' `INLINE_PACKAGES` is untouched.
- Build codegen step for the manifest + `.gitattributes` entry.

### 2. Codemod (`plugins/ui/plugins/icons/scripts/migrate-react-icons.ts`, deleted after)

Scale: about 630 files and 244 distinct `Md*` icons.

- **Imports:** `import { MdOpenInNew } from "react-icons/md"` becomes a
  module-level `const openInNewIcon = symbol("open-in-new");` plus
  `import { symbol } …`. The name comes from PascalCase → kebab-case, then
  lookup in `SymbolName`.
  - `MdOutlineX` / `MdXOutline` → `symbol("x")`: the style now comes from the
    theme.
  - `Si*` → `brand("…")`.
- **JSX:** `<MdX …props/>` → `<Icon icon={xIcon} …props/>`.
  - `size={n}` → a `size-*` class. There are 3 sites; hand-check them.
  - `title` / `style` / `aria-*` pass through.
- **Values:** `icon: MdX`, `Record<K, IconType>` values → `xIcon`.
- **Types:** `import type { IconType } from "react-icons"` (14 files) and the
  8 local `type IconType = ComponentType<{className?}>` slot aliases →
  `IconRef`. Every slot host that rendered `<item.icon className/>` becomes
  `<Icon icon={item.icon} …/>`, and tsc lists each one.
- **Unresolved names:** the codemod prints every `Md*` with no Symbols
  equivalent (e.g. `MdWarningAmber`). Map these by hand in a small table
  inside the script, then rerun. Nothing ships with a missing name, because
  tsc rejects it.
- **Pairs become `active`:** filled/outline pairs used as on/off (e.g.
  `MdPushPin` / `MdOutlinePushPin`) become one icon + `active={…}`, done by
  hand from the codemod's pair report. Also pass `active` for selected nav
  items: the app rail, sidebar nav, and view switchers.
- **Tests:** 3 suites name Md icons (`health-report`, `sidebar-nav-item`,
  `overflow-box`) and get updated to the new values. The 2 suites querying
  `svg path` (`avatar-cell`, `control-panel`) render stored `SvgNode`s or
  bare `<svg>` and are unaffected. Check them anyway.

### 3. Remove react-icons from code

- `icon-safety` lint:
  - new `no-react-icons` bans every `react-icons/*` import outside
    `primitives/icon-picker`, which remains its one user until the saved-icons
    task;
  - `no-namespace-react-icons` is narrowed to the icon-picker generator;
  - `no-robot-icon` moves to `symbol("smart-toy")`.
- `react-icons` stays a dependency only for icon-picker's generator. It is
  dropped by the saved-icons task.

## Critical files

- New: `plugins/ui/plugins/icons/{core,web,server,check}/…`,
  `plugins/ui/plugins/tokens/plugins/icons/{core/group.ts,web/…}`.
- `plugins/apps-core/plugins/app-icon/web/internal/app-icon.tsx`,
  `core/internal/app-icon-to-svg.ts`, `check/index.ts`.
- `plugins/framework/plugins/tooling/plugins/lint/plugins/icon-safety/lint/*`.
- Build codegen hook (`framework/plugins/cli` `regen-generated` pipeline) +
  `.gitattributes`.
- Slot declarations typed `IconType`: e.g. `tasks/plugins/launch-options/web/slots.ts`,
  `primitives/tree/web/internal/row-chrome.tsx`,
  `apps/plugins/events/plugins/events-core/web/slots.ts`,
  `auth/web/slots.ts`.
- ui-kit (`primitives/css/plugins/ui-kit/web/components/ui/*`), whose close,
  chevron and check icons are on every screen.

## Reused

- `useThemeScopeId`, `useResolvedTheme`, `defineTokenGroup`,
  `useTokenGroupEditor` / `TokenRows` (the theme-engine + customizer kit).
- `infra/boot-snapshot` resident resources.
- The in-sync-check pattern of `icon-picker/check`.
- The immutable-asset serving of `asset-mirror`.

## Verification

1. `./equin check` passes: tsc (every name resolves, every slot host
   updated), eslint (no `react-icons`, literal names), manifest in sync,
   app-icon check, boundaries.
2. `./equin test`, fully green.
3. `./equin build` succeeds, and the app renders with icons at first
   paint (screenshot harness, cold load, no empty icon boxes).
4. Theme: in the customizer, set an app to `rounded` / `filled` / `light` and
   screenshot that app beside another. Only that app changes, and no icon box
   shifts size.
5. `active`: the sidebar's selected item and pinned rows show filled glyphs
   under the default theme.
6. A before/after **contact sheet** of all ~250 icons (one e2e script
   rendering every manifest name under the default theme next to the old `Md*`
   component) is reviewed before push.
7. Mist prototype: flip its `icons` option to the same names, to compare
   against the real app.
8. The release CLI generates the favicon / Tauri icons from `appIcon` with no
   `react-icons` import.
