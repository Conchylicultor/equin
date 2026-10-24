# Pages app chrome: pixel match with proto-1790691924-p8nh

## Context

The structural pass ([2026-09-30-global-pages-mockup-chrome.md](2026-09-30-global-pages-mockup-chrome.md)) gave the Pages app the shape of the mockup `proto-1790691924-p8nh`:

- sidebar sections;
- the page toolbar;
- the title header with hover tools and inline backlinks.

It does not look like the mockup yet. `compare-diff.ts` at the mockup's defaults (`chips=muted, accent=iris, cards=typed`, 1440×900, dark):

- **6.9 %** of pixels differ, and 8 of 24 cells drift past ΔE 5.
- The surfaces are inverted:
  - Mockup: the page `#141416` is lighter than the sidebar `#0c0c0e`.
  - App: a near-black page `#0a0a0a` and a grey sidebar `#171717`.
- Most other differences are type size, row height, spacing and the shape of the menus.

**Scope:** the sidebar, the pane toolbar, and the title header (icon, hover tools, title, backlinks), plus every menu or popover opened from them. The annotation cards and the page body content stay out of scope, and so does the outline rail.

**Rule:** every difference is decided by the user. Either the app moves to the mockup, or the mockup moves to the app. Where the user wanted to see an alternative first, it becomes a mockup **variant**, and its default stays the original mockup.

**Global preferences, not touched:**

- the tree disclosure (`ui/tree-disclosure`);
- the breadcrumb separator (`ui/breadcrumb-separator`).

Any pixel difference they cause is expected.

## Decisions (user, 2026-10-01)

### App → mockup

| Area | Change |
|---|---|
| Theme | The mockup's "ink" palette becomes a **Pages app theme**. |
| Framing | Flush main area with a 1px left border, as a Pages-only `sidebar-framing` override (no inset card). |
| Toolbar | 46px tall, **no bottom border**. |
| Sidebar | A **workspace header** as a *static identity*: an initial tile plus "<name>'s pages", with no dropdown. |
| Sidebar | **Search as a box**: filled, 32px, hairline border. **No ⌘K hint.** |
| Sidebar | **Sentence-case section headers**, 11.5px, faint. |
| Sidebar | **30px rows, 13.5px regular text.** Favorites rows look identical to tree rows. |
| Sidebar | **14px indent** with **no guide line**. The mockup loses its guide line. |
| Sidebar | **Footer divider** above New page / Trash. |
| Toolbar | **Breadcrumb spacing**: 6px icon–title gap, 13.5px, the current page in regular weight. |
| Toolbar | **Outlined kind pill**: hairline border, 12.5px muted label. |
| Header | **Title 38px / weight 650.** |
| Header | **Quiet header tools**: 12.5px faint ghost buttons, 26px tall. |
| Header | **648px reading column**: max 760px, minus 56px padding on each side. |
| Header | **Backlinks toggle look**: 12.5px faint, 20px icon tiles. It keeps the app's `›` chevron, which rotates to `⌄` when open; the mockup changes to match. |
| Header | **Backlinks panel look**: a bordered card, the parent path right-aligned, the snippet indented under the icon, and the match in brighter medium weight. |

### Mockup → app, or a mockup variant first

| Item | Mockup change |
|---|---|
| ⌘K hint | Removed from the mockup's search box. |
| Workspace chevron | Removed: the header is static. |
| Tree guide line | Removed. |
| "Agents" section | Renamed **Scratch**, as already decided. |
| Icons (thin stroke vs Material Symbols) | New option `icons: stroke \| material`. The app keeps Material until the user picks. A new stroke icon set would be its own task. |
| Kind menu layout | New option `kind-menu: mockup \| app`. The mockup has the "Agents on this page" heading, icons on the left and the check on the right. The app has the "PAGE KIND" heading and the check on the left. |
| Page icon | New option `page-icon: tile \| bare`, to validate the tile before it ships. |
| Divider under the header | New option `header-rule: on \| off`. |
| Section ⋯ panel, icon picker, cover picker | No counterpart today. **Designed fresh in the mockup's style**, opened from the mockup's own `⋯`, Change icon and Add cover. The user reviews them before the app follows. |

## Phase 1 outcome (user, 2026-10-01)

- **`page-icon: bare`**: the app's current icon (72px glyph in an 80px hover box) stays. The mockup now draws it that way, and the 56px tile is dropped.
- **`kind-menu: mockup`**: the app adopts the mockup's menu:
  - the "Agents on this page" heading;
  - a kind icon on the left and the check on the right;
  - 300px wide;
  - the mockup's wording.
- **`header-rule: on`**: the app gains a 1px divider between the header and the body.
- **The three new menus** (section ⋯, icon picker, cover picker) are accepted as designed.
- **`icons: material`** (user, 2026-10-02). The mockup now draws Material Symbols in the **rounded outline** shape at weight **400**, with the closest glyph picked for each icon. The app keeps its own icon set; there is no new stroke set. Phase 2:
  - The Pages theme sets the `icons` group to `iconShape: "rounded"`, `iconFill: "outline"`, `iconStroke: "regular"`.
  - Every chrome control uses the mockup's glyph. Where the app names a different symbol today, it is switched:

    | Control | Glyph |
    |---|---|
    | Sidebar toggle | `dock-to-left` |
    | Change / Add icon | `sentiment-satisfied` (not `mood`) |
    | Sort | `swap-vert` |
    | Agent page kind | `flare` (not `auto-awesome`) |
    | Regenerate | `sync` |
    | Backlinks fallback | `undo`, if `link` reads wrong |

  - The full symbol-id → glyph map is the mockup's `<symbol>` set.

## Phase 1: mockup update

The mockup lives at `~/.singularity/apps/prototypes/proto-1790691924-p8nh/index.html`.

1. Housekeeping:
   - remove ⌘K;
   - remove the workspace chevron;
   - remove the indent guide;
   - rename Agents to Scratch;
   - the backlinks chevron becomes `›` and rotates on open.
2. Add the four options: `icons`, `kind-menu`, `page-icon`, `header-rule`.
   - Each default is the original mockup look: `stroke`, `mockup`, `tile`, `on`.
   - The `material` icons reuse the Material Symbols outline glyph SVG paths inline, because the mockup must open off disk.
   - The `app` kind menu reproduces today's menu in ink colours.
3. Fresh designs, each opened by a click in the mockup:
   - **Section ⋯ panel.** The section's controls (sort, filter, fold), the view actions (rename, type, duplicate, delete), "Add section", and the Scratch hint "Pages created by agent runs — moved to trash after 24h".
   - **Icon picker.** Emoji and icon tabs, search, the grid, and the Regenerate footer: the parts `PageIconPicker` + `RegenerateIconAction` have today.
   - **Cover picker.** The swatches and the remove action of `change-cover-popover.tsx`.
4. Make the mockup's sidebar tree and backlink rows show the **same pages, icons and titles** as the real page `block-acef974d-…`.
   - This is content only.
   - Without it, the pixel diff on those regions measures data, not design.
5. **Checkpoint:** the user reviews the variants and the three new menus.
   - Each chosen value becomes the mockup's markup, and that option is deleted.
   - Any menu change the user asks for comes back as one grouped question before the app is touched.

## Phase 2: app

Each item is tied to the strongest place that can hold it. Colours, sizes and metrics go through **tokens in a Pages theme**, so no other app changes. Component edits happen only where nothing is tokenised yet. Where a value is hard-coded in a shared primitive, it becomes a token whose default is today's value.

### 2.1 Pages theme `ink`

The precedent is the agent-manager Mist theme (`plugins/apps/plugins/agent-manager/plugins/shell/web/internal/theme.ts`, registered at `web/index.ts:22`).

- New `plugins/apps/plugins/pages/plugins/shell/web/internal/theme.ts`, built with `defineTheme({ id: "pages-ink", … })`.
  - It is contributed through `ThemeEngine.Theme` from the Pages shell web barrel.
  - It is selected by a new `config/ui/theme-engine/@app/pages/theme.jsonc` containing `{ "theme": "pages-ink" }`. There is no `colorMode`, since light/dark is global.
- Fragments (the mockup is dark-only, so each colour is a `{ light, dark }` pair whose light half stays the schema default):

  | Fragment | Tokens |
  |---|---|
  | `color-palette` | `background` `#141416`; `foreground` `#f0f0f2`; body text `#c8c8cf`; `mutedForeground` `#8a8a93`; `faintForeground` `#5a5a63`; `border` `rgba(255,255,255,.06)`; `accent` (hover) `#1b1b1e`; the selected row `#242428`; `popover` `#1b1b1e` with a `.10` line |
  | `sidebar-palette` | `sidebar` `#0c0c0e`; `sidebarBorder` `rgba(255,255,255,.06)`; `sidebarAccent` `#1b1b1e` |
  | `sidebar-metrics` | `sidebarPanelWidth` 260px; `sidebarRowHeight` 30px |
  | `density` | `chromePaneH` 46px; the new tokens in §2.2 |
  | `type-scale` | the body / label / caption / group role sizes for 13.5 / 12.5 / 11.5px; the `display` role (§2.2) at 38px / 650 / -0.025em |
  | `shape` | radius 8px, controls 6px |
  | `font-family` | Inter (already the default), `fontSmoothing: antialiased` |

### 2.2 New tokens (default = today's value)

- **`chromePaneRule`**: the pane bar's bottom border width, used in `primitives/bar/web/internal/bar.tsx` (`border-b`). Pages sets it to `0`.
- **`treeRowHeight` and `treeIndent`**: these replace the hard-coded `min-h-7` and `indentStep = 16` / `+4` in `primitives/tree/web/internal/tree-row-chrome.tsx`. Pages sets 30px and 14px.
- **`display` type role** (size, weight, tracking): `page-header.css` `.page-doc-title` reads it instead of the hard-coded 40px / 700.
- **`measureReading`**: replaces `READING_MEASURE`'s `max-w-4xl` (`page-tree/web/panes.tsx:67`) and the page column gutter. Pages sets 760px with 56px padding.
- Each token is added to its group's schema. Then `./equin check` keeps the role/token lint happy: no component-named type tokens, so it is `display`, not `page-title`.

### 2.3 Framing

- New `config/ui/sidebar-framing/@app/pages/…jsonc` with `{ "variant": "flush" }`.
- During implementation, check that a committed per-app override beats the user's runtime global pick (the app showed inset). If it doesn't, ask the user rather than work around it.

### 2.4 Sidebar (`plugins/apps/plugins/pages/plugins/…`)

- **Workspace header.**
  - A new `Pages.Sidebar` contribution `workspace`, first in `config/apps/pages/shell/sidebar.jsonc`.
  - It shows a 22px initial tile and "<name>'s pages".
  - The name is the **OS account's full name**, never hard-coded (user, 2026-10-01).
    - The server reads it once at boot: `id -F` on macOS (Directory Services RealName), the passwd GECOS field elsewhere, and `os.userInfo().username` if both are empty.
    - It is served as a small `liveValue`.
    - The first word of the name goes into "<first>'s pages", and its initial goes on the tile.
    - The header renders a loading state until the value arrives.
    - It belongs in a host-identity spot (e.g. beside `infra/runtime-identity`), not in page-tree, so other surfaces can reuse it.
- **Search box.**
  - `content-search`'s sidebar item becomes a filled box: 32px, `bg-muted`, hairline `border`, radius 8, search icon and "Search".
  - It has no kbd and still opens `QuickFindDialog`.
- **Section headers.** `pages-sidebar.tsx` passes the sections chrome `forms: { header: "group" }`, which is sentence case and the `group` role. The ink theme sizes the role at 11.5px / 550 and faint.
- **Rows.**
  - Tree rows get 30px and 14px indent from the §2.2 tokens.
  - The Favorites `list` rows render through the same row chrome / size as tree rows. Today they are 36px with smaller semibold text. The cause is located in `pages-sidebar.tsx` / data-view `list`.
- **Footer divider.** A hairline above `new-page`, via a sidebar divider item in `sidebar.jsonc` if the slot supports one; otherwise a `border-t` on the footer group.

### 2.5 Toolbar

- **`page-breadcrumb.tsx`**: the segment gap goes from `2xs` to 6px. The current page is in regular weight.
  - If the leaf's `font-medium` lives in `primitives/breadcrumb`, add a prop for the leaf's emphasis rather than changing it globally.
- **`page-kind-control.tsx`**: the trigger becomes an outline `Button` (hairline border, caption size, muted). The per-kind tint is kept.
- **Copy-id**: the icon goes to 14px, as in the mockup.

### 2.6 Title header

- **Page icon**: unchanged (bare, as chosen).
- **Kind menu** (`page-kind-control.tsx`):
  - the heading becomes "Agents on this page", in sentence case;
  - each row gets the kind icon on the left and the check on the right;
  - the descriptions take the mockup's wording;
  - the panel is 300px wide.
  - Prefer extending `ControlPanel.Row` (trailing check) over a page-local layout.
- **Header tools** (`header-tools.tsx`): `size="xs"` ghost buttons, caption text, faint tone, 14px icons.
- **Backlinks toggle** (`backlinks-section.tsx`): 20px rounded faces with a `bg-muted` fill and a 1px surface-coloured border, caption-size faint text, and the `›` chevron rotating.
- **Backlinks panel** (`page/plugins/links/web/components/backlinks.tsx`):
  - a bordered card, 10px radius, 4px padding;
  - rows with 8×10px padding;
  - the title line has the path pushed right;
  - the snippet is indented 24px, with `mark` in foreground and weight 500 and no highlight fill.
- **Header rule**: a 1px `border` line between the header and the body, 20px above and 28px below.

### 2.7 Menus from Phase 1

The section ⋯ panel, the icon picker and the cover picker follow whatever the user approved at the Phase 1 checkpoint. Their components:

- `data-view/web/components/view-section.tsx` with view-core's `ViewSettingsPopover` / `AddViewMenuItems`;
- `PageIconPicker`;
- `change-cover-popover.tsx`.

Shared primitives change only through theme tokens. Pages-specific layout changes stay in page-tree.

## Measuring

- **Whole screen:** run `compare-diff.ts --name proto-1790691924-p8nh --color-scheme dark` after every build, at the defaults.
  - Read the sidebar, toolbar and header cells.
  - Body cells are out of scope.
- **Menus:** screenshot.ts can only click visible buttons, and the section ⋯, Change icon and Add cover are hover-revealed.
  - Add `plugins/apps/plugins/pages/plugins/page-tree/e2e/chrome-capture.ts`, using the e2e-harness `withBrowser`.
  - For the app and for the mockup document, it hovers and opens each of: the kind menu, the section ⋯, the icon picker, the cover picker and the backlinks panel.
  - It writes paired crops, which go through the harness `diffImages` / `colorReport`.
- **Target:** under 1 % differing pixels in the in-scope cells, apart from the global-preference regions (tree disclosure, breadcrumb separator), and ΔE < 2 for every matched surface colour.
- Any residual difference that is neither noise nor already decided becomes another grouped question.

## Verification

- `./equin build` (background), then the compare and the capture above.
- Check light mode: the Pages theme must leave light mode as it is today.
- Check a second app (e.g. agent-manager) with screenshot.ts, to confirm the new tokens' defaults changed nothing.
- `./equin test plugins/primitives/plugins/tree plugins/primitives/plugins/bar plugins/apps/plugins/pages`, adding cases for the token-driven indent and row height.
- `./equin check`, including the token lint, `plugins-doc-in-sync` and config checks.

## Critical files

- `~/.singularity/apps/prototypes/proto-1790691924-p8nh/index.html`
- `plugins/apps/plugins/pages/plugins/shell/web/{index.ts,internal/theme.ts}`
- `config/ui/theme-engine/@app/pages/theme.jsonc`, `config/ui/sidebar-framing/@app/pages/`
- `plugins/ui/plugins/tokens/plugins/{density,type-scale}/core/group.ts`
- `plugins/primitives/plugins/{bar/web/internal/bar.tsx,tree/web/internal/tree-row-chrome.tsx}`
- `plugins/apps/plugins/pages/plugins/page-tree/web/{panes.tsx,components/{pages-sidebar,page-header,header-tools,backlinks-section,page-breadcrumb,page-icon-button}.tsx,components/page-header.css}`
- `plugins/apps/plugins/pages/plugins/page-author/web/components/page-kind-control.tsx`
- `plugins/apps/plugins/pages/plugins/content-search/web/components/*` (search box)
- `plugins/page/plugins/links/web/components/backlinks.tsx`
- `config/apps/pages/shell/sidebar.jsonc`
