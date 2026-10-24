# App launcher grid as a DataView

## Context

The app-launcher popover (`plugins/apps-core/plugins/app-launcher/web/components/app-launcher.tsx:150`)
hand-rolls its own grid of app tiles: the tile layout, caption, current-app dot,
hover and focus styling, and a 4-column arrow-key model. Home's gallery
(`plugins/apps/plugins/home/plugins/app-cards/web/components/app-grid.tsx`) draws
the same records as a `DataView` with the `icons` view. The two copies have
already drifted: `dece612040` had to move Home's tile palette into
`APP_TILE_PALETTE` so the launcher would match.

`data-view/no-adhoc-row-list` missed it because it only matches `.map` → bare
`<Row>`, and the launcher maps to `<Stack as="button">`.

**Goal:** the launcher renders `<DataView views={["icons"]}>` over the app rows,
so the tile, caption, current marker and keyboard model have exactly one
implementation (the icons view). Home gets keyboard navigation as a side effect.

## Design

### 1. Icons view (`primitives/data-view/plugins/icons`)

`icons-view.tsx` honours two props it already receives in `DataViewRenderProps`
but ignores today:

- **`density === "compact"`**: a smaller fixed geometry, with no container-query
  swap. Cells of about 72px with tiles of about 36px, an `xs` column gap and a
  `sm` row gap, `gap="xs"` between tile and caption, and tighter tile padding.
  The geometry moves into one `geometryFor(density)` value that both the grids
  and the probe read, so the probe still counts the right tracks. The cell size
  is tuned so the `picker` popover width fits 4 columns, as the launcher does
  today. The comfortable geometry is unchanged.
- **`selectedRowId`**: the matching tile gets `aria-current="true"`, its caption
  in `text-foreground`, and a small dot under it via `Pin to="bottom"`, the
  marker the launcher draws today. This uses the existing DataView meaning of
  "the selected row", the same one list highlights.

**Roving focus** for every icons view, generic:
- Only one tile is a tab stop (`tabIndex=0`): the last-focused tile, else the
  selected one, else the first. All others are `tabIndex=-1`. The state is the
  focused row key, held in the view.
- One `onKeyDown` on the view root (`@container/icons`). ArrowLeft and
  ArrowRight move to the previous or next tile in DOM order. ArrowUp and
  ArrowDown move to the nearest tile in the previous or next visual row, read
  from the tiles' `getBoundingClientRect()` (closest centre-x among tiles whose
  top differs). This works for any `auto-fill` column count and across group
  sections without knowing `columns`. Home and End go to the first and last
  tile. Tiles are found as `[data-row-key][role="button"]` inside the root.
  Rows with no `rowActivation` are not buttons and are skipped.
- Known limit: in a windowed section (over 120 tiles), ArrowUp/Down only reach
  lanes `VirtualRows` has mounted (overscan covers the adjacent lane). This is
  documented in the plugin's CLAUDE.md, not worked around.

The tile keeps `role="button"` and Enter/Space activation. The launcher loses
`role="menu"`/`menuitem` and becomes a grid of buttons with roving focus, which
matches Home and is valid ARIA for a launcher.

### 2. Shared app fields (`apps-core/plugins/app-launcher`)

`appFields: FieldDef<ActiveApp>[]` in `app-launcher/web`: the tile (leading,
`cell` → `<AppIconTile className="size-full">`, which sets the
`APP_TILE_PALETTE` vars itself) and the name. Home's `AppGrid` and the launcher
both render it.

*Revised during implementation:* the first draft put an accessor-generic
`appTileFieldDef` in `app-icon`, but `apps-core` imports `app-icon` and
data-view's imports reach back to `apps-core` (via shell/toast →
chrome-theme → theme-engine), so `app-icon` → data-view is a cycle
(`plugin-boundaries`). `app-launcher` already sits above both.

### 3. Launcher (`apps-core/plugins/app-launcher`)

`app-launcher.tsx`'s popover `content` becomes:

```tsx
<DataView<ActiveApp>
  rows={launchable}                 // useLaunchableApps — rail order, unchanged
  rowKey={(a) => a.id}
  fields={appFields}
  views={["icons"]}
  defaultView="icons"
  density="compact"
  selectedRowId={activeId}
  storageKey={LAUNCHER_VIEW}        // defineDataView("apps-core.launcher")
  toolbar={launcherToolbar(close, galleryLink)}
  onRowActivate={(a) => { close(); activate(a); }}
/>
```

- **No toolbar band:** a `HostedToolbar` (`kind: "hosted"`) whose frame renders
  `body`, then the existing footer line: "All apps" on the left and the hosted
  `options` trigger hover-revealed at the end. The hosted contract requires
  `options` to be rendered somewhere. It also means typing to filter apps works
  in the popover, at no cost. `switcher` and `creators` are `null` (one view, no
  creators). `stickyRef` stays unattached because nothing sticks.
- `defineDataView("apps-core.launcher")` registers its own views config through
  codegen (`data-views.generated.ts`). It is separate from `home.apps`, so the
  popover never offers Home's views and the reverse.
- Delete `COLS`, `STEP`, `onMenuKeyDown` and the hand-rolled tile JSX, plus any
  imports that become unused (`Grid`, `Stack`, `Pin`, `Text`, `AppIconTile`).
- Update `app-launcher/CLAUDE.md`: the grid is the icons DataView, compact.

### 4. Docs

- `data-view/plugins/icons/CLAUDE.md`: compact density, `selectedRowId` marker,
  roving focus and its windowing limit.
- `docs/plugins-*.md` are regenerated by the build.

## Critical files

- `plugins/primitives/plugins/data-view/plugins/icons/web/components/icons-view.tsx`
- `plugins/apps-core/plugins/app-launcher/web/components/app-fields.tsx` (new, exported)
- `plugins/apps-core/plugins/app-launcher/web/components/app-launcher.tsx`
- `plugins/apps/plugins/home/plugins/app-cards/web/components/app-grid.tsx`
- `plugins/apps-core/plugins/app-launcher/e2e/launcher.ts`

Reused: `useLaunchableApps` / `useActivateApp` / `appLinkProps` (unchanged),
`AppIconTile`, `HostedToolbar` (`data-view/core/internal/toolbar-arrangement.ts`),
`selectedRowId` / `density` threading (`data-view-body.tsx:718`), and the
precedent of a compact DataView in a popover (`QuickThemePicker`,
`theme-gallery/web/components/theme-pickers.tsx`).

## Verification

1. `./equin test plugins/primitives/plugins/data-view/plugins/icons`:
   extend `icons-view.test.tsx` with (a) compact density applying the compact
   geometry class, (b) `selectedRowId` setting `aria-current` and the marker,
   (c) roving tabindex: exactly one `tabIndex=0`, ArrowRight/Left/Home/End move
   focus. Up/Down depend on layout, which jsdom does not compute, so they are
   covered in e2e.
2. `./equin build` (runs `type-check`, `eslint`, `plugins-doc-in-sync` and
   `plugins-registry-in-sync`).
3. Update and run `app-launcher/e2e/launcher.ts`: replace the `menu`/`menuitem`
   locators with the tiles (`[data-row-key]` buttons inside the popover). Keep
   every existing assertion: ArrowDown opens with focus on a tile, ArrowRight
   moves, ArrowDown moves a row, Esc returns focus, a click switches app. Add:
   the current app's tile has `aria-current`.
4. Screenshots of the launcher popover (dark and light) and of Home's gallery,
   compared to before: the launcher should look the same as today, apart from
   the hover-revealed options trigger in the footer, and Home should be
   unchanged.
