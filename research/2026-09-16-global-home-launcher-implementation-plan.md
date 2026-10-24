# Home launcher — implementation plan

Implements the design record
[`2026-09-16-global-home-app-gallery-redesign.md`](2026-09-16-global-home-app-gallery-redesign.md)
(decisions 1–10 are not re-opened here). Target: prototype `proto-1789509871-llga` at
`style=flat, palette=ocean, surface=black, header=capsule`.

## Context

`/home` shows every installed app as a gallery record card. The user approved a
phone-home-screen launcher instead: 72px coloured squircle tiles with the name
underneath, on a black page, under a centred "Apps" title and one pill-shaped bar
(view chip, search with `/`, filter/sort/fields circles, round New app button).
The prerequisite — a DataView row can declare a leading avatar field
(`avatarFieldDef`, `FieldDef.leading`, `leadingSlot`) — landed in `0389a0ec9`.

The work splits into six pieces, each reusable beyond Home.

## 1. Avatar: shape, tile presentation, second shade — `primitives/avatar`

What the user sees: nothing changes for any existing avatar. Inside a launcher
tile, the same `<Avatar>` fills the tile with a solid colour and a white glyph.

- **New `core/` barrel** with the closed colour list (`AVATAR_COLOR_NAMES`,
  `AvatarColor`) and `AvatarShape = "circle" | "squircle"`. Needed so
  `apps-core/app-icon/core` can type an app's colour without importing web code.
- **Shape travels with the icon.** `AvatarProps.shape?: AvatarShape` (default
  `circle`) and `AvatarFieldData` gains `shape?` (not the persisted picker
  `AvatarSpec` — people and agents have no shape choice). Squircle =
  a new named `rounded-squircle` utility (`border-radius: 26%`) in the radius
  plugin's CSS with its `twmerge` marker. It is a proportional shape like
  `rounded-full`, so it is correctly outside the `--radius` preset scale; the
  `no-adhoc-radius` rule only flags bare/arbitrary radii, so it passes untouched.
- **Ambient presentation**, copying `ControlSizeProvider`
  (`css/plugins/ui-kit/web/theme/control-size.tsx`):
  `AvatarPresentationProvider` / `useAvatarPresentation()` with
  `"badge"` (default: today's density-ramp size + soft paint) and `"tile"`
  (box fills its parent — the view sizes the tile — flat fill, white glyph at
  46% of the box, no status-dot ring). `size?: never` stays.
- **Colour pick** (`web/internal/colors.ts`): refactor to
  `avatarColorPick(color, fallbackKey) → { slot, shade }`.
  - `slot` = today's rule exactly (`hash % 8` over `AUTO_ORDER`, explicit colour
    wins) — so the soft classes are byte-identical.
  - `shade` = `Math.floor(hash / 8) % 2` for automatic picks, `0` for an explicit
    colour. 8 × 2 = 16 tile colours.
  - Flat class table: 10 slots × 2 shades as literal Tailwind strings; shade 1 is
    `oklch(from var(--categorical-N) calc(l + 0.13) c h)`.
  - Unit test pins the soft class for a fixed set of keys (agent ids,
    category keys) against the pre-change function → proves "existing avatars
    unchanged".

## 2. App icon colour — `apps-core/app-icon`

- `AppIcon = { kind: "md"; svgNodes; color?: AvatarColor }`;
  `mdAppIcon(Icon, { color? })`.
- Settings (`apps/plugins/settings/plugins/shell/web/index.ts`):
  `mdAppIcon(MdSettings, { color: "slate" })`. No other app declares one — their
  colours derive from the app id.

## 3. `icons` DataView view — new `primitives/data-view/plugins/icons`

- `DataViewSlots.View({ type: "icons", title: "Icons", icon: MdApps,
  loadingVariant: "cards", supportsManualOrder: true, component: IconsView })`.
  Group-by keeps working through `useDataViewSections` like gallery.
- **Grid**: `css/grid`'s `Grid` has no fixed-width-centred mode (both arms are
  `1fr`). Add a third arm to its closed union, `{ cellWidth: string }` →
  `repeat(auto-fill, cellWidth)` + `justify-content: center`. No lint disable at
  the call site. Tile column 116px / gap `26px 14px`; under 760px column 92px,
  tile 60px (container query on the view root, not viewport).
- **Item**: a focusable tile whose `onClick` is `props.rowActivation?.(row)`
  (passed straight through, per the render-props contract). Glyph =
  `leadingSlot({ field: pickLeadingField(fields), … })` inside
  `<AvatarPresentationProvider value="tile">`; a schema with no leading field
  gets `<Avatar fallbackKey={rowKey} fallbackGlyph={initial}>` so switching any
  DataView to icons still draws something. Name = primary field via
  `pickPrimaryField`, one truncating line, muted → foreground on hover/focus.
  Hover lift / active press motion from the mock.
- **Drag to reorder**: same wiring as `list-view.tsx` — `RankReorderProvider`
  over `manualOrderItems(...)`, each tile `useRankReorderItem(id, rank, group)`.
  `rank-reorder` is flat before/after; a grid renders one linear rank, so the
  tile's left half is `beforeRef` and right half `afterRef`, drawn as a vertical
  insertion bar. Order persists through the existing `view-order` contribution
  (the host's `rowOrderEnabled` gate passes once `supportsManualOrder` is true).
- Windowing: reuse gallery's `VirtualRows` column-lane mode above its threshold.
- Item actions / selection / aggregate: not rendered (a launcher has none); the
  view simply ignores those props, as the design record's decision 1 intends.

## 4. Toolbar arrangement seam — `primitives/data-view`

What the user sees: every existing DataView toolbar is unchanged. Home's toolbar
becomes the capsule.

- **Contract** (`data-view/core`):
  ```ts
  interface ToolbarArrangement {
    id: string;
    /** Forms the host builds the parts in — data, so parts stay host-built. */
    forms: { search: "field" | "bare"; controls: "ghost" | "round"; creators: "labelled" | "round" };
    component: ComponentType<ToolbarParts>;
  }
  interface ToolbarParts {
    title: ReactNode;
    switcher: { strip: ReactNode; chip: ReactNode };   // chip = collapsed switcher (§5)
    search: ReactNode; focusSearch: () => void; query: string;
    controls: ReactNode;        // one trigger per applicable DataViewSlots.Control
    foldedControls: ReactNode;  // same controls behind one trigger (no search)
    actions: ReactNode; creators: ReactNode;
  }
  ```
- **Selection**: `DataViewProps.toolbar?: ToolbarArrangement` — the consumer
  passes the arrangement *value* it imported. Default is the host's own
  `barArrangement` (today's wide branch moved verbatim into a component). The
  host never names capsule; no registry or string id lookup needed.
- **Host keeps**: the `<Sticky>` band, `stickyRef` measurement and
  `--dv-header-offset`, `hoverRevealGroup`, control applicability/order, and the
  **compact fold** (`density="compact"` or < 360px renders today's compact branch
  regardless of arrangement). `DataViewToolbar` becomes: measure → compact ?
  fold : `<arrangement.component {...parts}/>`.
- `SearchInput` gains `appearance?: "field" | "bare"` (bare = borderless, fills
  its cell, trailing `<kbd>/</kbd>`, Esc clears and blurs). `ControlTrigger` and
  `CreatorsControl` take the round form (`shape="pill"` circle; creators filled).
- **Capsule arrangement** — new `primitives/data-view/plugins/capsule-toolbar`,
  exports `capsuleToolbar`: horizontally centred pill (`min(620px,100%)`, 48px,
  `rounded-full`, raised surface via `Surface`, border brightens on
  focus-within) holding chip switcher · search (the one grow cell) · divider ·
  controls · creators. Below ~560px of capsule width, divider + three circles
  swap for `foldedControls` (one circle) — filter/sort stay reachable, unlike the
  mock which just hides them. `/` focuses search through `useSurfaceShortcuts`
  (surface-scoped, so two DataViews in two tabs don't fight). A non-empty query
  keeps search visible (it is always rendered here).

## 5. Collapsed view switcher — `data-view/plugins/view-core`

- Extract the inline add-menu branch of `editable-view-switcher.tsx`
  (flat single-source vs sectioned multi-source) into `AddViewMenuItems`, used by
  both switchers.
- `CollapsedViewSwitcher` (same inputs: `instances`, `activeId`, `onSelect`,
  `actions`): one chip — active view icon, name, chevron — opening a menu of the
  other views, `AddViewMenuItems`, and "View settings…" which opens the existing
  `ViewSettingsPopover` anchored to the chip. No drag reorder.
- `data-view.tsx` shell builds both nodes into `chrome.switcher` (`null` both
  when pinned). Using the chip in the compact fold is left for later.

## 6. Home — `apps/plugins/home`

- **Theme** — `home/plugins/shell/web/internal/theme.ts`, contributed via
  `ThemeEngine.Theme`, following `website/plugins/shell/web/internal/theme.ts`:
  - `colorPaletteGroup.fragment` dark: background `oklch(0 0 0)`, card/popover
    `0.155`, secondary/accent/muted `0.19`–`0.23`, border `oklch(1 0 0 / .09)`,
    input `/.16`, foreground `0.97`, muted-foreground `0.7`. Light: a readable
    neutral light palette (complete, so `assertComplete` passes).
  - `categoricalGroup.fragment` both modes: slots 1–8 = ocean,
    `oklch(L 0.11 175 + 17·i)` with `L` alternating `0.50 / 0.57` (shade 1 adds
    0.13 → the mock's 0.63 / 0.70 band); slot 9 continues the band; slot 10 =
    `oklch(0.48 0.02 250)`.
  - `config/ui/theme-engine/@app/home/theme.jsonc` → `{ "theme": "home" }` with the
    same `// @hash` as website's (same descriptor), comment mirroring website's.
  - Scoped by `pane-box.tsx`'s `data-theme-scope="app:home"`, so Debug's charts
    and agent avatars elsewhere keep their colours.
- **`app-grid.tsx`**: fields = `avatarFieldDef({ id: "icon", label: "Icon",
  leading: true, avatar: (a) => ({ icon: null, svgNodes: a.icon.svgNodes,
  color: a.icon.color ?? null, shape: "squircle", fallbackKey: a.id }) })` + name;
  `views={["icons"]}`, `defaultView="icons"`, `toolbar={capsuleToolbar}`; drop
  gallery `viewOptions` and `showCreateCard`; keep the New app creator stub and
  row activation; empty state "No app matches. Build one?" for a filtered result.
- **`home-layout.tsx`**: centre the title block (34px title, subtitle 6px below,
  capsule 26px below, grid 60px below), 64px vertical padding (40px under 760px),
  column `min(920px, 100% − 40px)`.
- **Config**: `config/apps/home/app-cards/home.apps.jsonc` view type → `icons`.

## Order of work

1 → 2 → 5 → 4 → 3 → 6. Each step builds and leaves every existing surface
unchanged until step 6 switches Home over.

## Risks to check early

- `RankReorderProvider`'s collision detection with side-by-side (left/right)
  droppables instead of stacked ones — verify before building the rest of §3.
- The sticky toolbar's `bg-chrome-mask` must resolve to black under Home's theme
  (check the chrome token isn't in a group Home's theme leaves at defaults).
- Home's theme replaces the *whole* theme for the Home scope (one theme per
  scope): groups it doesn't mention (fonts, radius, density) paint schema
  defaults instead of the desktop's choice — same as the website app today.

## Verification

- `./equin test plugins/primitives/plugins/avatar` — soft-class pin test;
  unit tests for `avatarColorPick` shade distribution and `Grid` `cellWidth`.
- `./equin check` (radius, layout, surface, boundaries, config-origins).
- `./equin build`, then
  `compare-diff.ts --name proto-1789509871-llga --options style=flat,palette=ocean,surface=black,header=capsule --width 1280`,
  and at 700 wide.
- `screenshot.ts --path /home` in `--color-scheme dark` and `light`.
- Before/after screenshots: Debug timeline (charts), agents list (avatars),
  conversation category avatars, any DataView toolbar (e.g. tasks list) — identical.
- E2E in `plugins/apps/plugins/home/e2e/launcher.ts`: drag a tile, reload, order
  persists; `/` focuses search, Esc clears; chip menu switches view / opens
  settings; a narrow pane shows the compact fold; clicking a tile opens the app.
