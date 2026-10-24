# Agent icon family — custom icons with sidebar hover motion, Debug → Icons, strict families

## Context

The agent manager should have its own icon set: the line icons designed in prototype
`proto-1789643584-ldt6` (`agent-icons.js`, `icons: agent` option, 62 glyphs). Each icon
plays a small one-shot motion on hover, like Claude's icons. The user asked for three things:

1. **Motion only in the sidebar.** Not in the toolbar or in menus (queue, filter, …).
2. **Debug → Icons.** One page that shows every icon set of every app side by side. For each
   app set it shows which names the set draws itself and which still fall back to Lucide or
   Material. Prototype: `proto-1792665946-7atw6e`.
3. **Enforcement.** An app can be held to its own set. The user picked a staged approach:
   **fallback now, strict later**. User-picked icons (agent avatars), brands, file types and
   emoji are **exempt**.

Most of this already exists, in `plugins/ui/plugins/icons`:

- **Families.** `defineIconFamily` and `Icons.Family`
  (`core/icon-family.ts`, `web/slots.ts`).
- **Per-app selection.** An app's theme carries `iconsGroup.fragment(both({ iconFamily }))`.
  Sonata does this today: `apps/sonata/plugins/shell/web/internal/theme.ts:160`.
- **Fallback chain.** `familyChain` / `resolveIconDrawing` in `web/internal/icon-drawing.ts`
  already returns each drawing's `source`.

Three things are missing:

- **Motion.** Glyphs are drawn through `<use>`, and outer CSS cannot reach a `<use>` shadow
  tree. `checkBody` allows shape elements only.
- **A strict mode.**
- **A page.**

## Design

### 1. The family: `apps/agent-manager/plugins/icons`

- **`core/agent-icons.ts`.** Holds
  `defineIconFamily({ id: "agent", label: "Agent", stroke: 1.6, fallback: "lucide", glyphs, symbols })`.
  - The glyph bodies are ported from the prototype's `agent-icons.js`.
  - `symbols` maps the **Material names the app draws** to glyphs. The keys are Material
    names, not Lucide names. Examples: `checklist` → list-checks,
    `precision-manufacturing` → bot, `chat-bubble`, `insights`, `add`, `close`,
    `expand-more`, `search`, `content-copy`, …
  - The prototype's Lucide-name keys turn into glyph names. The mapping is the porting work:
    about 60 of the roughly 180 names reachable from `conversations`, `tasks`, `primitives`
    and `shell`. The rest fall back to Lucide and appear on the Debug page.
- **`web/index.ts`.** `contributions: [Icons.Family({ family: agentIcons })]`, the same
  one-liner Sonata uses (`apps/sonata/plugins/primitives/plugins/icons`).
- **Selecting it.** Add `iconsGroup.fragment(both({ iconFamily: "agent" }))` to `mistTheme` in
  `apps/agent-manager/plugins/shell/web/internal/theme.ts`.

### 2. Motion: a closed vocabulary in the icons primitive, played only inside a motion region

**Glyph data.** A part of a glyph body that moves carries `data-motion="<kind>"`. It can add
`data-motion-delay="70"` (ms) and `data-motion-origin="12 13"` (grid units).

- `<kind>` comes from a **closed set** in icons `core/icon-motion.ts`, named `ICON_MOTIONS`:
  nudge-up, nudge-down, nudge-left, nudge-right, turn, pop, draw, blink, blink-y, bob, type,
  scan, tilt, scribble, shake, slide, splay-l, splay-r, link-a, link-b, open-l, open-r,
  squeeze, grow, hop, drift, flip, rewind, bubble, launch, flicker, light, twinkle, spark.
  These are the prototype's motions.
- `checkBody` validates every `data-motion*` attribute against that set when the family is
  defined. It throws, so an unknown motion fails as soon as the family module loads.
- `IconGlyph` gains a derived `animated` flag, true when the body holds any `data-motion`.

**Drawing.** `<Icon>` draws a family glyph whose source is an animated glyph inline: a
`<g>` holding the body, with paint as in `familyGlyphMarkup`. It does not use `<use>`.

- `useIconMarkup` already produces a symbol's inner markup; reuse its family path.
- Every other glyph keeps `<use>`.
- Inline drawing means plain CSS can reach the parts. It costs a few DOM nodes per icon, and
  only for animated family glyphs.

**Trigger.** Pure CSS, no JS hover controller.

- An icons-owned stylesheet (`web/internal/icon-motion.css`, imported by `IconFamilyHost`)
  holds one keyframe per motion. It has rules of the form
  `[data-icon-motion-region] :is(a, button, [role=button], [role=option], [role=treeitem], [role=menuitem]):hover [data-motion="nudge-right"] { animation: … }`.
- A CSS animation restarts each time the selector starts matching. So it plays once per
  hover entry and settles back to rest.
- `prefers-reduced-motion: reduce` disables it.
- Delay and origin are applied through `style="--d:…; transform-origin:…"`, written when the
  body is drawn.

**Sidebar only.** The icons barrel exports
`IconMotionRegion = { "data-icon-motion-region": "" }` (attribute props). One caller spreads
it: the app-shell sidebar root, in `primitives/app-shell/web/components/app-shell-layout.tsx`.

- Every app's sidebar becomes a motion region. Only families with animated glyphs move, which
  today is only `agent`.
- The toolbar, menus, popovers and transcript are never inside a region, so they stay still.
  This holds even though they draw the same family.
- Portalled menus opened from the sidebar sit outside the region's DOM, so they are excluded
  automatically.

### 3. Strict families (staged: fallback now, strict later)

- `defineIconFamily` / `InlineIconFamily` gain `coverage: "fallback" | "strict"`.
  - It is **required**: tsc makes every family state it.
  - `strict` forbids `fallback` through a discriminated union (`{ coverage: "strict" }`
    without `fallback`).
- `agent` ships as `coverage: "fallback", fallback: "lucide"`. Sonata and Prototypes declare
  `"fallback"`.
- **Strict at runtime.** In a scope whose family is strict, a `symbol()` the family does not map
  resolves to a **gap drawing**, never to Material or Lucide.
  - A gap drawing is a dashed rounded square: one `<symbol>` in the family sheet.
  - It files one report per (family, name) through the reports plugin, kind `IconFamilyGap`.
  - This is rung 4, a loud runtime failure, and it is precise: a name counts only when it
    is actually drawn in that app.
- **Exempt.** Only `symbol` refs are subject to strictness. `brand`, `seti`, `runtime-symbol`
  (avatars and other user-picked icons), `custom` and emoji keep their own drawing.
  `resolveIconDrawing` already branches on `icon.kind`, so the rule is local.
- **No raw icons in the app.** `no-lucide-react` already exists. Add the lint
  `icons/no-inline-svg-icon`: a `.tsx` under an app with a `coverage: "strict"` family may not
  hand-draw an `<svg>` icon. Brand marks such as `equin-mark.tsx` are exempted in the app's
  `exempt/index.ts`, `kind: "sanctioned"`. This is a follow-up; it is not needed while the
  family is in fallback mode.
- **Flipping to strict** is a one-word change, made once Debug → Icons shows 0 fallbacks for the
  app.

### 4. Debug → Icons: `plugins/debug/plugins/icons`

The page follows the `render-profiler` pattern: `Pane.define` and
`DebugApp.Sidebar({ id: "icons", icon: symbol("category"), opens })`.

- **Data.** All of it is generic, with no family named, per collection-consumer separation:
  - `useIconFamilies()` gives the columns. Material is a built-in column.
  - `Apps.App.useContributions()` together with each app's theme `iconFamily` gives the left
    list (app → its family, coverage, strict or not).
  - The rows (concepts) are the Material names in the build's icon manifest. Each row shows
    its call-site count.
- **Resolution.** A cell shows what that family draws for the name.
  - Export a pure helper from the icons web barrel:
    `resolveIconSource(name, familyId) → { kind: "own" } | { kind: "fallback", family } | { kind: "gap" }`.
    It is built on `familyChain` and is the same chain `<Icon>` walks, so the page cannot
    disagree with what the app draws.
  - Fallback cells are dimmed and badged **L** (Lucide) or **M** (Material).
  - A strict family's gap cells show the dashed placeholder.
  - Each cell is drawn by a real `<Icon>` under an `IconScopeProvider` whose style names that
    family. The page renders the actual glyphs; it does not reimplement them.
- **Views.**
  - **Matrix**: rows are concepts, columns are families.
  - **By set**: one tile grid per family.
  - Both views have search, a size control (16/20/24/40) and a "Fallbacks only" filter.
- **Motion.** The page body is wrapped in `IconMotionRegion`, so hovering a row plays every
  animated glyph in it.
- **Rows.** The matrix uses a `DataView` (`views={["list"]}`, groupBy family coverage), as the
  data-view rule requires for domain records.

## Files

- **New:**
  - `plugins/apps/plugins/agent-manager/plugins/icons/{core,web}/index.ts` and
    `core/agent-icons.ts`.
  - `plugins/debug/plugins/icons/{web/index.ts, web/panes.tsx, web/components/*}`.
  - `plugins/ui/plugins/icons/core/icon-motion.ts`.
  - `plugins/ui/plugins/icons/web/internal/icon-motion.css`.
- **Edit:**
  - In `plugins/ui/plugins/icons`:
    - `core/icon-family.ts`: `coverage`, `data-motion` validation, `animated`, gap symbol.
    - `web/internal/icon-drawing.ts`: strict gap and `resolveIconSource`.
    - `web/internal/icon.tsx`: inline draw for animated glyphs.
    - `web/internal/family-host.tsx`: CSS import.
    - `web/index.ts`: exports.
  - `apps/agent-manager/plugins/shell/web/internal/theme.ts`: iconFamily.
  - `primitives/app-shell/web/components/app-shell-layout.tsx`: region.
  - Sonata and Prototypes icon families: add `coverage: "fallback"`.
- Update the icons `CLAUDE.md` (motion vocabulary, regions, strict).

## Verification

- `./equin test plugins/ui/plugins/icons`. New tests:
  - `defineIconFamily` throws on an unknown motion.
  - The chain resolution of `resolveIconSource` for own, fallback and gap.
  - A strict scope draws the gap, not Material.
  - Exempt kinds are untouched.
- `./equin build`, then the `browser_*` tools on `/agents`:
  - The sidebar draws agent glyphs.
  - Hovering a nav row adds the animation: computed `animation-name` on a `[data-motion]`
    part is non-`none`.
  - Hovering a toolbar or menu button does not.
- `/debug/icons`, checked by screenshot:
  - The agent column shows own glyphs and L-badged fallbacks.
  - The counts match.
  - Temporarily flipping `agent` to strict shows gaps and files `IconFamilyGap` reports.
- `./equin check`, including the plugin boundaries and the `plugins-registry-in-sync`
  check.
