# Pages app chrome: pixel match with proto-1790691924-p8nh (v2, implementation)

## Context

v1 ([2026-10-01-global-pages-mockup-pixel-match.md](2026-10-01-global-pages-mockup-pixel-match.md)) recorded the user's decisions. The mockup `proto-1790691924-p8nh` is now final, with no in-scope variant options left. This plan turns v1 into concrete code changes, using what the codebase has today.

**Scope:**
- the sidebar;
- the pane toolbar;
- the title header (icon, hover tools, title, backlinks);
- every menu or popover opened from those.

**Out of scope:** the page body, the annotation cards, the outline rail, and the mockup's "Show properties" tool (the app has no properties).

**Untouched:** the tree disclosure and the breadcrumb separator. Both are global user preferences.

**Source of truth:** the mockup and the user's requirement list. Where the mockup's inline SVG differs from a glyph the user named, the user's name wins (`flare`, `sentiment-satisfied`, `sync`, `dock-to-left`, `swap-vert`).

### Decisions (user, 2026-10-02)

- **Sizes apply in both colour modes.** The Pages theme sets every metric with `both()`. The ink colours are dark-only (`light: {}`), so light mode keeps today's colours but gets the new layout.
- **The cover picker keeps the pink "Sunset" first swatch.** Only its layout follows the mockup.

## Rule for every change

- Colours and metrics go through tokens set by the Pages theme.
- When a shared primitive hard-codes a value, that value becomes a token whose default is today's value, so no other app changes.
- Pages-only layout stays in Pages plugins.
- When a shared primitive lacks a shape the mockup needs, it gains an opt-in prop whose default is today's behaviour.

## 1. Theme, tokens, framing

### 1.1 New tokens (default = today's value)

| Token | Group | Default | Consumer |
|---|---|---|---|
| `selected` | color-palette | `var(--accent)` | the selected tree row and list row (`tree-row-chrome.tsx:182`, the list view's active row). Hover stays `accent`, so hover (`#1b1b1e`) and selected (`#242428`) can differ. |
| `groupForeground` | color-palette | `var(--muted-foreground)` | the `group` variant of `SectionHeaderRow` (`primitives/css/plugins/row/web/internal/section-header-row.tsx`) and the control-panel section head (§5) |
| `popoverBorder` | color-palette | `var(--border)` | the ui-kit popover / dropdown content border |
| `chromePaneRule` | density | `1px` | `bar.tsx:107`: the pane tier's `border-b` width. Chrome and subpane tiers are unchanged. |
| `treeRowH` | density | `1.75rem` | `tree-row-chrome.tsx:175`, replacing `min-h-7` |
| `treeIndent` | density | `16px` | `tree-row-chrome.tsx:142,186`. `indentStep` loses its default and reads the token; the `+4` base stays. Update `primitives/tree/e2e/subtree-fold.ts:49,57`. |
| `fontWeightDisplay`, `fontWeightGroup` | type-scale | `var(--font-weight-bold)` / `var(--font-weight-semibold)` | In `primitives/css/plugins/text/core/roles.ts`, `display` and `group` switch to `weight: "token"`, so `roleTokenKeys()` derives these keys and the `closed-role-ladder` check stays satisfied. |
| popover widths | wherever `popover-width.ts` reads them | today's ramp | Pages needs `menu` 300px (kind menu), `builder` 248px (section ⋯) and `picker` 328px (icon and cover). If the ramp is plain constants, lift it into tokens first. |

Each new token:
- gets its Tailwind mapping or `@utility` in `ui-kit/web/theme/app.css`;
- needs `./equin build` to regenerate `token-group-vars.generated.ts`.

### 1.2 `pages-ink` theme

New file `plugins/apps/plugins/pages/plugins/shell/web/internal/theme.ts`, written `defineTheme({ id: "pages-ink", … })` on the Mist pattern (`agent-manager/plugins/shell/web/internal/theme.ts`).

It is contributed as `ThemeEngine.Theme(pagesInkTheme)` from `pages/plugins/shell/web/index.ts`, and selected by `config/ui/theme-engine/@app/pages/theme.jsonc`:

```jsonc
// @hash <copied from theme.origin.jsonc>
{ "theme": "pages-ink" }
```

**Colours** (`light: {}`, dark values from the mockup):

| Token | Dark value |
|---|---|
| `background` | `#141416` |
| `foreground` (default text) | `#c8c8cf` |
| `strongForeground` | `#f0f0f2` |
| `mutedForeground` | `#8a8a93` |
| `faintForeground`, `groupForeground` | `#5a5a63` |
| `border` | `rgba(255,255,255,.06)` |
| `popoverBorder` | `rgba(255,255,255,.10)` |
| `accent` (hover) | `#1b1b1e` |
| `muted` | `#1b1b1e` |
| `selected` | `#242428` |
| `popover` | `#1b1b1e` |
| `sidebar` | `#0c0c0e` |
| `sidebarBorder` | `.06` |
| `sidebarAccent` | `#1b1b1e` |

- The fg-1 / fg-2 split (title and active text vs body text) is the first thing to check with `colorReport` on each region.
- Popover rows must hover at `#242428`. The popover surface's `--hover-fill` (`app.css` ~1753, currently `var(--muted)`) must resolve to the selected tier there.

**Metrics** (`both()`):

| Group | Values |
|---|---|
| density | `chromePaneH` 2.875rem (46px); `chromePaneRule` 0; `treeRowH` 1.875rem (30px); `treeIndent` 14px |
| sidebar-metrics | `sidebarPanelWidth` 16.25rem (260px); `sidebarRowHeight` 1.875rem |
| type-scale | body 13.5px; label / caption 12.5px; group 11.5px at weight 550; display 38px / line-height 1.15 at weight 650; `measureReading` (§4) |
| shape | radius 8px, controls 6px, card 10px |
| font-family | Inter, `fontSmoothing: antialiased` |
| icons | `iconShape: "rounded"`, `iconFill: "outline"`, `iconStroke: "regular"` |

**Check:** body 13.5px must not shrink the page body's prose (16px), which is out of scope. Confirm whether the editor's prose reads the `body` role. If it does, the sidebar rows and breadcrumb use `label` sized 13.5px instead, and caption carries 12.5px.

### 1.3 Framing

- New `config/ui/sidebar-framing/@app/pages/sidebar-framing.jsonc` with `{ "variant": "flush" }`, copying the base `@hash 3b71fc14a37d`. Precedent: `@app/agent-manager`.
- Flush draws the seam as the sidebar's `border-r` (`ui-kit/.../sidebar.tsx:274`). That gives the same 1px line as the mockup's left border on main.
- Check that the committed per-app file beats the user's current runtime pick (the app shows inset today). If it does not, stop and ask; do not work around it.

## 2. Sidebar

### 2.1 Workspace header

**New plugin `plugins/infra/plugins/host-account`.** Search `docs/plugins-details.md` first for an existing "OS user / full name" read.

| Barrel | Content |
|---|---|
| `core` | `liveValue` `host-account` → `{ fullName, username }` |
| `server` | `serveValue` (external source). It reads once at boot through `infra/spawn` `spawnCaptured`: `id -F` on darwin, the passwd GECOS field elsewhere, then `os.userInfo().username`. |
| `web` | `useHostAccount()` via `useLive`, returning the loading state until the value arrives |

**Pages contribution `workspace`** (in `pages/plugins/shell`): a `Pages.Sidebar` component item, placed first in `config/apps/pages/shell/sidebar.jsonc`.
- It shows a 22px initial tile (`bg-selected`, hairline border, 12px weight 600) and "<first name>'s pages" (13.5px, weight 550, strong).
- No dropdown, no chevron.
- It renders a loading state, never a placeholder name.

### 2.2 Search box

`content-search/web/components/pages-search.tsx` becomes a filled button:
- 32px tall, `bg-muted`, hairline `border`, radius 8;
- padding `0 8 0 10`, 13px muted text;
- the `search` icon at 14px, then "Search";
- no kbd;
- the same `onClick` (QuickFindDialog).

Reuse `SearchInput appearance="field"`'s chrome class if it is exported. Otherwise build it from the `Row`/`Inline` primitives.

### 2.3 Section headers

- `pages-sidebar.tsx:41`: `SECTIONS = { kind: "sections", forms: { header: "group" } }`. This gives sentence case on the `group` role (11.5px / 550 in Pages) in `groupForeground`.
- In `data-view/web/components/view-section.tsx`, the header actions swap to the mockup's order: ⋯ first, then +.

### 2.4 Rows

- Tree rows pick up 30px and 14px from the new tokens, and the selected row uses `bg-selected`. There is no guide line today, so nothing to remove.
- **Favorites look identical by construction.** The `favorites` view in `config/apps/pages/page-tree/pages-sidebar.jsonc` becomes a `tree` view with no nesting (flat, starred filter). It then renders through the same `TreeRowChrome`.
  - If the tree view cannot be flat, the list view gets a `rowChrome: "tree"` option instead. Two hand-tuned chromes is not an option.
- Labels: in Pages the `body` role (or `label`, see §1.2) is 13.5px at weight 400. The active row is weight 500 in `strongForeground`.

### 2.5 Footer

- **Divider.** A new generic reorder node type `divider` (`plugins/reorder/plugins/node-types/plugins/divider`, sibling of `spacer`) renders a hairline `border-t` with 6px above and below. It goes in `sidebar.jsonc` before `new-page`.
- **New page / Trash** render as sidebar nav rows: `sidebarRowHeight`, 16px icon, muted text, so they match the 30px rows. They keep their current behaviour (busy state, trash dialog).

### 2.6 Sidebar toggle

- `SidebarTrigger` (`ui-kit/.../sidebar.tsx:291`) gains an optional `icon`, and `AppShellLayout` an optional `sidebarToggleIcon`.
- The Pages shell passes `symbol("dock-to-left")`.
- Every other app keeps `left-panel-*`.

## 3. Pane toolbar

- **Height and rule:** 46px with no bottom border, from the theme (§1.2).
- **Breadcrumb** (`page-tree/web/components/page-breadcrumb.tsx`): `SegmentLabel` gets a 6px gap (the nearest spacing step, or `gap-[6px]` if none exists) and 13px emoji.
  - `primitives/breadcrumb/web/internal/breadcrumb.tsx:194` gets a `leafWeight: "medium" | "normal"` prop (default `medium`). Pages passes `normal`.
  - The leaf colour is `strongForeground`; ancestors are muted.
- **Kind pill** (`page-author/web/components/page-kind-control.tsx`):
  - an outline `Button`, 28px tall, hairline `border`, 12.5px caption at weight 500, muted;
  - a 14px kind icon, the label, and a 14px faint `keyboard-arrow-down`;
  - the per-kind tints stay;
  - the agent icon becomes `flare`.
- **Copy-id:** a 14px icon.
- **Edited label:** 12.5px, faint.

## 4. Title header and backlinks

### 4.1 Reading column

- `page-tree/web/panes.tsx:67`: `READING_MEASURE` reads `max-w-(--measure-reading)` instead of `max-w-4xl`.
- First audit the other consumers of `measureReading` (75ch prose); they must be unaffected.
- Pages sets the measure so that the header's content box is **648px**, which is 648px plus twice the existing `BLOCK_GUTTER` + `BLOCK_INSET`. The centred content box then lands where the mockup's 760px − 2×56px column does.
- `BLOCK_GUTTER` is not changed (body scope).

### 4.2 Header

- **Page icon:** unchanged, bare (`page-icon-button.tsx`).
- **Title:** `page-header.css` `.page-doc-title` reads the `display` role: size, line height and weight tokens, colour `strongForeground`, `letter-spacing: -0.025em`.
- **Header tools** (`header-tools.tsx`): `Button variant="ghost" size="xs"`, 26px tall, 12.5px caption, faint text, 14px icons, 4px gap.
  - The Add and Change icon tools use `sentiment-satisfied`; Add cover uses `image`.
- **Divider:** in `panes.tsx`, a 1px `border` rule between the header and the editor, with a 20px margin above and 28px below.

### 4.3 Backlinks

**Toggle** (`page-tree/web/components/backlinks-section.tsx`):
- an xs ghost button: 12.5px, faint, 6px gap;
- 20px `Faces` tiles with a 6px radius, `bg-muted`, a 1px `border-background`, and 12px emoji;
- the `›` chevron at 14px, rotating to `⌄` when open (already in place).

**Panel** (`page/plugins/links/web/components/backlinks.tsx`):
- The panel becomes a card:
  - hairline border, 10px radius, 4px padding;
  - `bg-background`;
  - −10px horizontal margin, 6px top margin.
- Each row:
  - 8×10px padding, 8px radius, hover `bg-accent`.
- Title line:
  - 13.5px at weight 500, strong colour;
  - the path pushed right (`ml-auto`), 12px faint, regular weight.
- Snippet:
  - indented 24px, 12.5px muted, one line with ellipsis;
  - the match in `<mark>` uses `foreground` at weight 500 with no fill.
- Fallback icon: `link`, unless it reads wrong next to the mockup; `undo` is the user's fallback.

## 5. Menus

**Shared popover look** (theme only):
- `bg-popover` (`#1b1b1e`) with a `popoverBorder` line;
- 10px radius, 6px padding, shadow `0 18px 48px -12px rgba(0,0,0,.7)`;
- rows 30px tall with a 7px radius, hovering at `#242428`.

**Control-panel additions** (opt-in, defaults unchanged):
- `ControlPanel.Section` gets a heading form `"group"`: sentence case, 11.5px, `groupForeground`. The default stays the eyebrow.
- `ControlPanel.Row` gets `indicator: "trailing"` for `select="radio" | "check"`. The check moves to the trailing cell, while role and aria stay. The leading cell then holds `icon`.
- A row that pushes a panel shows a trailing 14px `chevron-right` after its value, if it does not already.

### 5.1 Kind menu

- `size="menu"`, 300px wide.
- Heading "Agents on this page" in the group form.
- Each row: the kind icon on the left, a 13px / 500 title, a 12px muted description, and a trailing check.
- Descriptions, verbatim from the mockup:

  | Kind | Description |
  |---|---|
  | Page | "Agents can read it and add notes in their own cards. Your text stays yours." |
  | Agent page | "Agents may write anywhere on it." |
  | Instructions | "Standing instructions for every agent working under the parent page." |

- The instructions-only **Global** switch row stays, with "Point every conversation at this page".

### 5.2 Section ⋯ panel

The existing `SectionRootPanel` already has the mockup's parts: note, search, control rows, Section settings and Add section. The changes:

- 248px wide.
- The search placeholder reads "Search pages…".
- Rows are Sort, Filter and Properties, each with a trailing value and chevron.
  - Reorder the controls through their slot if it is reorderable per app.
  - If the order can only change globally, ask before changing it.
- The scratch note gets the mockup's text with its full stop: "Pages created by agent runs — moved to trash after 24h." It lives in `pages-sidebar.jsonc:89`.

### 5.3 Icon picker

`PageIconPicker` + `ui/icons/plugins/emoji` `EmojiPicker`:
- 328px wide.
- A 30px search field on `bg-background` with a hairline border and the placeholder "Search emoji…".
- Sentence-case category heads (11.5px faint).
- A **9-column** grid of 32px cells with 19px emoji, the selected cell in the accent soft fill plus ring.
  - This goes through new `EmojiPicker` props (`columns`, `cellSize`). The defaults are today's values.
- A leading **Recent** category, fed by the `usage-rank` primitive: `recordUsage("page-icon", emoji)` on pick, then `useUsageOrder`.
- The footer has Regenerate (`RegenerateIconAction`, icon becomes `sync`) and Remove (muted, `close`).
- The scroll area is 236px tall.

### 5.4 Cover picker

`change-cover-popover.tsx`:
- 328px wide.
- The "Gradient" head in the group form.
- A 5-column grid with a 6px gap and `2px 8px 8px` padding.
- Swatches are 40px tall with a 7px radius, a hairline border, `hover:scale-[1.04]`, and the selection ring kept.
- The 10 presets stay unchanged, Sunset first (user).
- The footer has the "Upload an image" row with the `upload` icon.

## 6. Measuring

- **Whole screen:** `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1790691924-p8nh --color-scheme dark` after each build. Read only the sidebar, toolbar and header cells.
- **Menus:** new `plugins/apps/plugins/pages/plugins/page-tree/e2e/chrome-capture.ts`, using the harness `withBrowser`, `snap`, `diffImages` and `colorReport`.
  - For the app and for the mockup, it opens:
    - the kind menu;
    - the section ⋯ panel (hover the section header first);
    - the icon picker (`.page-icon` / Change icon);
    - the cover picker (hover the header, then Add cover);
    - the backlinks panel.
  - It writes paired crops plus a diff and a colour report.
  - Mockup selectors: `[data-act="kind"]`, `.section[data-section="private"] [data-act="sect-more"]`, `[data-act="icon-pick"]`, `[data-act="cover-pick"]`, `[data-act="bl"]`.
- **Target:**
  - under 1% differing pixels in the in-scope cells, excluding the tree-disclosure and breadcrumb-separator regions;
  - ΔE < 2 on every matched surface colour.
- Any residual that is neither noise nor already decided goes back to the user as one grouped question.

## Order of work

1. Tokens (§1.1) and the theme, theme selection and framing (§1.2–1.3). Build, then confirm no other app changed.
2. Sidebar (§2).
3. Toolbar (§3).
4. Header and backlinks (§4).
5. Menus (§5).
6. `chrome-capture.ts`, then iterate on the diffs.

## Verification

- `./equin build` (in the background), then compare-diff and chrome-capture in dark mode.
- Light mode: screenshot `/pages/page/block-acef974d-…` with `--color-scheme light`. Today's colours stay; the new sizes apply.
- Other apps: screenshot agent-manager and home before and after. They should be pixel-identical, since every new token defaults to today's value.
- `./equin test plugins/primitives/plugins/tree plugins/primitives/plugins/bar plugins/primitives/plugins/css plugins/apps/plugins/pages plugins/infra/plugins/host-account`. Add cases for:
  - the token-driven indent;
  - the trailing radio indicator;
  - the host-account name parse (id -F, GECOS, fallback).
- `./equin check`, including:
  - `type-scale:closed-role-ladder`;
  - `token-group-vars-in-sync`;
  - `icons:manifest-in-sync`, since new glyphs (`flare`, `sentiment-satisfied`, `sync`, `dock-to-left`) regenerate the manifest;
  - `config-origins-in-sync`;
  - `plugins-doc-in-sync` and the boundary checks.

## Critical files

- `plugins/apps/plugins/pages/plugins/shell/web/{index.ts,internal/theme.ts}`
- `config/ui/theme-engine/@app/pages/theme.jsonc`, `config/ui/sidebar-framing/@app/pages/sidebar-framing.jsonc`
- `config/apps/pages/shell/sidebar.jsonc`, `config/apps/pages/page-tree/pages-sidebar.jsonc`
- `plugins/ui/plugins/tokens/plugins/{color-palette,density,type-scale}/core/group.ts`, `plugins/primitives/plugins/css/plugins/text/core/roles.ts`, `ui-kit/web/theme/{app.css,popover-width.ts}`
- `plugins/primitives/plugins/{bar/web/internal/bar.tsx,tree/web/internal/tree-row-chrome.tsx,breadcrumb/web/internal/breadcrumb.tsx}`
- `plugins/primitives/plugins/css/plugins/{row/web/internal/section-header-row.tsx,control-panel/web/internal/control-panel-row.tsx,control-panel/web/internal/control-panel.tsx,ui-kit/web/components/ui/sidebar.tsx}`
- `plugins/primitives/plugins/data-view/web/components/view-section.tsx`
- `plugins/reorder/plugins/node-types/plugins/divider/` (new), `plugins/infra/plugins/host-account/` (new)
- `plugins/apps/plugins/pages/plugins/page-tree/web/{panes.tsx,components/{pages-sidebar,page-header,header-tools,backlinks-section,page-breadcrumb,page-icon-button,change-cover-popover,new-page-item}.tsx,components/page-header.css}`
- `plugins/apps/plugins/pages/plugins/{page-author/web/components/page-kind-control.tsx,content-search/web/components/pages-search.tsx,auto-icon/web/components/regenerate-icon-action.tsx,trash/web/components/pages-trash.tsx}`
- `plugins/page/plugins/links/web/components/backlinks.tsx`, `plugins/ui/plugins/icons/plugins/emoji/web/components/emoji-picker.tsx`
