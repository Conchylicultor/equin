# Home app gallery redesign — design record

Status: **design agreed with the user, not started.** Filed as a task that waits
on the DataView avatar field
([`2026-09-16-global-data-view-avatar-field.md`](2026-09-16-global-data-view-avatar-field.md)),
which is its prerequisite. The implementing agent should still write its own plan
(the `plan` skill) before building — this doc records the decisions and research
so they aren't re-litigated, not a step list.

## Context

The Home app (`/home`) shows a launcher of every installed app. Today it is a
DataView gallery of record cards (`plugins/apps/plugins/home/plugins/app-cards/web/components/app-grid.tsx`):
each app is a wide tinted cover frame with the glyph inside, a title below.

The user designed a replacement in prototype **`proto-1789509871-llga`** (lives
at `~/.singularity/apps/prototypes/proto-1789509871-llga/index.html`, declares
`<meta name="mocks" content="route:/home">`). The mock explores four option axes.
The user picked **one value per axis; every other option was an experiment and
is not kept**:

| Axis | Picked | Discarded |
|---|---|---|
| `style` (icon treatment) | **flat** | soft, outline, glyph, tile, neutral |
| `palette` | **ocean** | spectrum, jewel, pastel, neon, earth, nord, sunset, violet, retro |
| `surface` | **black** | graphite, stone |
| `header` | **capsule** | tabs, title |

Open the mock with those options to see the target
(`?style=flat&palette=ocean&surface=black&header=capsule` via the prototypes app's
option picker), and compare with
`./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1789509871-llga --options style=flat,palette=ocean,surface=black,header=capsule`.

## The target, measured from the mock

### Page frame
- One centred column shared by header and grid: `--col: 116px`, `--gap-x: 14px`,
  7 columns max → width `min(7·116 + 6·14 + 24 = 920px, 100% − 40px)`, `margin: 0 auto`.
- Vertical padding 64px top and bottom.

### Header (capsule)
- Centred title block: H1 "Apps" 34px / weight 600 / letter-spacing −0.035em;
  subtitle "Open an app to get started." in the faint tone, 6px below.
  Home's layout (`plugins/apps/plugins/home/plugins/shell/web/components/home-layout.tsx`)
  **already renders this exact copy** — it needs centring and spacing, not new structure.
- The capsule: one pill, `width: min(620px, 100%)`, 48px tall, 26px below the
  subtitle, horizontal padding 6px, radius 24px, `surface` background, 1px
  `line` border that becomes `line-2` on `:focus-within`. Left to right:
  1. **View chip** "Apps ▾" — 36px tall, padding `0 8px 0 12px`, radius 18px,
     background white at 6%, 13.5px / 500; leading view icon 17px (muted),
     trailing chevron 18px (faint). This is a *collapsed* view switcher.
  2. **Search** — fills the remaining width; gap 8px, padding `0 10px 0 12px`,
     search icon 19px, input 14px, placeholder "Search apps", trailing `<kbd>/</kbd>`.
  3. A 1×20px vertical divider in `line-2`, 4px margins.
  4. **Filter / Sort / Fields** controls as 34px circles
     (icons `filter_list`, `swap_vert`, `tune`).
  5. **New app** — 36px circle, filled with the text colour, glyph in the page
     background colour, icon 20px, 4px left margin.
- Keyboard: `/` focuses search; `Esc` in search clears it and blurs.

### Grid
- 60px below the capsule. `grid-template-columns: repeat(auto-fill, 116px)`,
  `justify-content: center`, gap `26px 14px`.
- Item: column, centred, gap 11px, padding `10px 4px 8px`, radius 18px, focusable.
- **Tile**: 72px square, radius `72 × 0.26 ≈ 18.7px` (squircle), glyph at
  `72 × 0.46 ≈ 33px`, centred. **Flat**: solid tint fill, white glyph.
- **Name**: 13px, muted; becomes the text colour on hover / focus-visible; no wrap.
- Motion: hover or focus lifts the tile `translateY(-2px)`; active presses it to
  `scale(.96)`; `transition: transform .2s cubic-bezier(.3,.7,.4,1.3)`.
- No trailing "+" card — creation lives in the capsule.
- Empty search result: "No app matches. Build one?".
- Under 760px: column 92px, gap-x 8px, tile 60px, top padding 40px; the capsule
  hides its three control circles and the divider.

### Surface (black)
`bg oklch(0 0 0)` · `surface oklch(0.155 0 0)` · `surface-2 oklch(0.19 0 0)` ·
`surface-3 oklch(0.23 0 0)` · `line oklch(1 0 0 / 0.09)` · `line-2 oklch(1 0 0 / 0.16)` ·
`text oklch(0.97 0 0)` · `muted oklch(0.7 0 0)` · `faint oklch(0.52 0 0)`.

### Palette (ocean)
Only cool hues, told apart by lightness. For the 12 coloured apps, index `i`:
`oklch(L 0.11 H)` with `L = [0.50, 0.64, 0.57, 0.70][i % 4]` and `H = 175 + 11·i`
(teal 175° → violet-blue 296°). Settings is the one grey: `oklch(0.48 0.02 250)`.
Every ocean tint is dark enough for a white glyph (the mock only switches to a
dark glyph above L 0.72, which ocean never reaches).

Not built: the mock's red unread-count badge and green "live" dot. No app
publishes either today.

## Decisions (agreed with the user)

1. **The launcher item is a new DataView view type, `icons`** — a sibling of
   `table` / `gallery` / `list` / `tree` under
   `plugins/primitives/plugins/data-view/plugins/`, contributing
   `DataViewSlots.View({ type: "icons", … })`. **Not a gallery option**: gallery is
   built on exactly one `DataCard` construction site so a card can never drop an
   affordance the surface declared (action zones, selection, aggregate badge). A
   launcher item has none of those, so a "no chrome" gallery flag would hollow out
   gallery's one guarantee. Search, filter, sort and group-by live in the host and
   keep working.

2. **The glyph comes from the row's leading avatar field** (`FieldDef.data` +
   `leading: true`, authored with `avatarFieldDef`), delivered by the
   prerequisite avatar-field work — *not* a new per-view `glyph` producer. The
   icons view renders that field in its tile the same way list/gallery/tree
   render it in their leading slot.
   Today "a row's visual identity" is a per-view option named differently in each
   view (gallery `cover`/`leading`, list `leading`); a fourth would repeat the
   smell, and switching Home's view in config would lose the icons. See the
   avatar-field doc for the final API names.

3. **Drag-to-reorder is on.** The `icons` view declares
   `supportsManualOrder: true`, so the existing contributed per-view order
   (`data-view/plugins/view-order`) makes apps draggable like a phone home screen.
   Check the host's `rowOrderEnabled` gate and the rank-reorder integration the
   list/table views use.

4. **Tile paint lives on `Avatar`, split by what each property describes.**
   `Avatar` today is round, painted "soft" (15% wash + coloured glyph), sized only
   by the shared control-density ramp (`xs|sm|md|lg`, max 48px, `size?: never`).
   A 72px squircle is not a bigger Avatar, so:
   - **Shape travels with the icon** — an app is a squircle wherever it appears,
     a person is round. It belongs in the avatar spec.
   - **Size and paint come from where it's shown** — a launcher tile is large and
     flat; a table cell or list row stays small and soft. The icons view supplies a
     **tile presentation** ambiently, the way `ControlSizeProvider` supplies
     density. Existing avatars must not change.
   - **Do not** add an `xl` tier to `ControlSize` (it's the ramp every button and
     input shares) and **do not** build a variant region for the treatment (only
     flat was kept; a one-option switcher is ~15 files for a closed set).

5. **Tints come from the existing `categorical-1…10` tokens — no new token group.**
   The avatar's automatic colour already hashes a key into `categorical-1…8`
   (`plugins/primitives/plugins/avatar/web/internal/colors.ts`, `AUTO_ORDER`).
   Home has no charts, and themes are per-app scoped, so Home's own theme retunes
   those tokens to the ocean band without touching any chart elsewhere.
   - Colour is **derived from the app id**, never from grid position (position
     changes under sort, filter and search).
   - **Derive a second shade per colour** in CSS from the same token (e.g. a
     lightness step via `color-mix`/relative colour), picked by the hash too. 13
     apps over 8 auto slots would otherwise repeat; 8 × 2 = 16 distinct matches the
     mock's twelve-distinct look. Must not change the colour today's soft avatars
     pick (that would recolour every agent avatar).

6. **Settings is grey via an explicit colour, not a neutral flag.** The palette's
   grey slot (`slate` → `categorical-10`) is already excluded from the automatic
   pick. An app's icon gains an optional colour; Settings declares `slate`; Home's
   theme sets `categorical-10` to the mock's settings grey. Nothing is tied to app
   categories (they don't exist yet and would re-tint unrelated apps when they do).

7. **Home ships a default theme in code.** Precedent: the website app —
   `plugins/apps/plugins/website/plugins/shell/web/internal/theme.ts`
   (`defineTheme({ id, fragments: [colorPaletteGroup.fragment(…), chartGroup.fragment(…)] })`,
   contributed via `ThemeEngine.Theme`) selected by the committed
   `config/ui/theme-engine/@app/website/theme.jsonc` → `{ "theme": "equin" }`.
   Home's theme: a `colorPaletteGroup` fragment (black page, lifted `card`/`popover`,
   white-alpha `border`/`input`) plus a `categoricalGroup` fragment (ocean band,
   settings grey in slot 10). Selected by `config/ui/theme-engine/@app/home/theme.jsonc`
   with the `// @hash` from the generated origin.
   - Scoping is structural: `pane-box.tsx` stamps `data-theme-scope="app:home"`
     on every Home pane, and the injector emits Home's tokens under that selector.
   - Light mode must resolve too (`assertComplete` throws otherwise; per-scope
     colour mode is deferred). Author a readable light fallback.

8. **The DataView toolbar hands its parts to an arrangement.** The toolbar
   already names no control (it reads `DataViewSlots.Control`); what is still
   hardcoded is the *shape* of the bar. Today's bar stays the default arrangement;
   **capsule** is the one new arrangement. The mechanism for a surface to choose
   one is for the implementing agent to design (respect collection-consumer
   separation — the host must not name an arrangement).
   - **The compact fold stays in the host.** Below the 360px breakpoint or under
     `density="compact"` everything folds behind one options popover. That's a
     policy about room; an arrangement only chooses the *wide* layout, so no new
     arrangement can break narrow panes.
   - **The page title/subtitle is Home's**, not the DataView's.

9. **A collapsed view switcher is added beside `EditableViewSwitcher` in
   `view-core`** — one chip naming the active view whose menu holds the other
   views, add, and settings. The narrow toolbar can use it too (it currently
   side-scrolls the chip strip).

10. **Home's config row switches to the new view** —
    `config/apps/home/app-cards/home.apps.jsonc`:
    `{"views":[{"id":"apps","name":"Apps","view":{"type":"icons"}}]}`.
    Adding a view type doesn't invalidate the committed hash.

## Research findings to reuse

### Toolbar parts and what breaks if an arrangement mishandles them
`data-view/web/components/toolbar/data-view-toolbar.tsx` builds: a title node
(cheap), the **switcher** (mounted node from the shell), a **search input**
(mounted once, relocated between layouts), **control** metadata from
`DataViewSlots.Control` (triggers built per control, panels mount only when open),
consumer **actions** (node), and the **creators control** (mounted once, relocated).
An arrangement must place these pre-built nodes, never re-instantiate them.
Hazards:
- **Sticky + header offset.** The shell measures the sticky toolbar
  (`stickyRef`) and publishes `--dv-header-offset`, which grouped views stack
  their sticky section headers below. A centred, non-full-width capsule changes
  what is sticky and measured.
- **Hover-reveal scope.** `hoverRevealGroup` sits on the toolbar's `<Sticky>` band
  on purpose; a different ancestor must re-establish it.
- **One grow cell.** In the bar the switcher is the single `flex-1` cell pushing
  everything right (no `ml-auto`). In the capsule, search is the grow cell.
- **The switcher is the only way to add/rename/reorder views**, so every
  arrangement must render it.
- **A non-empty query must stay visible** — never drop search while a query is
  active (see data-view CLAUDE.md "State split").

### Collapsed switcher
`view-core/web/components/editable-view-switcher.tsx` mixes selection (click
inactive → select; click active → settings popover), drag reorder
(`SortableList`), and the hover-revealed `+` add menu. A collapsed form reuses
the inputs (`instances`, `activeId`, `onSelect`, `actions: ViewActionsCore`) and
`ViewSettingsPopover` as-is, drops drag reorder, needs a different way into
settings (a menu row), and should share the add-menu items (single-source flat
list vs multi-source sections) with the strip rather than copy them.

### Layout primitives
`Grid` (`css/grid`: `minCellWidth` xor `cols`) for the tile grid, `Center` for
centring, never raw flex/grid (`layout/no-adhoc-layout`). DataView bands pay
their own inset with `rail-follow`. Read the `css` and `theme` skills first.

### Avatar blast radius
`<Avatar>` has 9 call sites; `avatarColorClass` is only called inside
`avatar.tsx`. A default that keeps today's look changes none of them.

## Rejected alternatives (don't re-open without new information)

- A dedicated launcher colour token group — unnecessary; Home's per-app theme
  retunes `categorical-*` locally.
- Index-based colours — unstable under sort/filter/search.
- A `neutral`/`colorless` flag on the app — the existing `slate` slot expresses it.
- A variant region for icon treatment — only flat was kept.
- An `xl` control-density tier for the tile — shared ramp.
- The mock's `tile` style as a treatment — it's a card with a small icon, i.e.
  the gallery view.
- A per-view `glyph` producer — superseded by the identity field.

## Verification (for the implementer's plan)

- `./equin build`, then compare with the prototype using `compare-diff.ts`
  (command in Context) at 1280 wide; check under 760px too.
- `screenshot.ts --path /home` in dark and light colour scheme.
- Debug app charts unchanged (their categorical colours must not shift).
- An agent avatar and a conversation-category avatar look identical before/after.
- Drag an app to a new position; reload; the order persists.
- `/` focuses search, `Esc` clears; switching views from the collapsed chip works;
  a narrow pane still gets the compact fold.
